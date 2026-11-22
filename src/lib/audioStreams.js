// ═══════════════════════════════════════════════════════════
//  audioStreams.js  –  live microphone streams on the audio server
//
//  Unlike camera streams (peer to peer through the vision server), the audio
//  server is the hub: a mic publishes to it once, it keeps a rolling buffer
//  the brain's tools can read ("what's happening in the kitchen?"), and any
//  number of clients listen. Both directions are one-shot WebRTC exchanges,
//  WHIP/WHEP style — no signalling socket:
//
//    POST {AUDIO_BASE}/v1/streams/{id}/listen            body: SDP offer (recvonly)
//    POST {AUDIO_BASE}/v1/streams/{id}/publish?name=…    body: SDP offer (sendonly)
//      → 201, body: SDP answer, Location: the session (DELETE it to stop)
//
//  The server does not trickle ICE, so the offer goes out once gathering has
//  finished (or after 2 s, with whatever candidates there are by then).
// ═══════════════════════════════════════════════════════════

import { AUDIO_BASE } from './endpoints.js'
import { audioNetworkError, audioResponseError, authHeaders } from './audioApi.js'
import { getClientId } from './clientId.js'

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]
const ICE_GATHER_MS = 2000

const STREAM_MESSAGES = {
  400: 'The audio server could not use this connection offer.',
  403: 'That stream belongs to someone else.',
  404: 'That stream does not exist (any more).',
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/**
 * A promise that rejects with an AbortError when `abort()` is called. Raced
 * against the offer/answer exchange: closing a peer connection while
 * createOffer() is pending leaves that promise unsettled for good (Chrome),
 * and a stopped listen() must still settle.
 */
function abortable() {
  let abort
  const promise = new Promise((_, reject) => { abort = () => reject(abortError()) })
  promise.catch(() => {})
  return { promise, abort }
}

function streamUrl(streamId, action) {
  return `${AUDIO_BASE}/v1/streams/${encodeURIComponent(streamId)}/${action}`
}

/** Streams the signed-in user can see: [{id, name, owner, source, live, buffered_s, listeners, …}]. */
export async function listStreams({ signal } = {}) {
  let res
  try {
    res = await fetch(`${AUDIO_BASE}/v1/streams`, { headers: authHeaders(), signal })
  } catch (err) {
    throw err?.name === 'AbortError' ? err : audioNetworkError(err)
  }
  if (!res.ok) throw await audioResponseError(res, {}, `Could not list audio streams (HTTP ${res.status}).`)
  const data = await res.json()
  return Array.isArray(data?.streams) ? data.streams : []
}

/**
 * This device's mic stream id: `${clientId}_mic`, reduced to the characters
 * the server accepts in an id (A-Z a-z 0-9 _ . -, at most 64) — a device name
 * may contain spaces or anything else.
 */
export function micStreamId(clientId = getClientId()) {
  return `${clientId}_mic`.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-64)
}

function waitForIceGathering(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => { if (pc.iceGatheringState === 'complete') done() }
    const timer = setTimeout(done, ms)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

/** Offer → answer. Returns the session URL to DELETE when done. */
async function exchange(pc, url, isStopped) {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc, ICE_GATHER_MS)
  if (isStopped()) throw abortError()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/sdp' }),
      body: pc.localDescription.sdp,
    })
  } catch (err) {
    throw audioNetworkError(err)
  }
  if (!res.ok) throw await audioResponseError(res, STREAM_MESSAGES, `The audio server refused the stream (HTTP ${res.status}).`)

  const answer = await res.text()
  const location = res.headers.get('Location')
  const sessionUrl = location ? new URL(location, `${AUDIO_BASE}/`).toString() : null
  if (isStopped()) {
    closeSession(sessionUrl)
    throw abortError()
  }
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  } catch (err) {
    closeSession(sessionUrl)
    throw err
  }
  return sessionUrl
}

function closeSession(sessionUrl) {
  if (!sessionUrl) return
  // keepalive: still sent when this runs because the page is closing.
  fetch(sessionUrl, { method: 'DELETE', headers: authHeaders(), keepalive: true }).catch(() => {})
}

/** connected → 'live'; failed / disconnected / closed as they are. */
function watchConnection(pc, onState) {
  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState
    onState?.(s === 'connected' ? 'live' : s)
  })
}

/**
 * Listen to a stream live.
 *
 * Resolves to { stop, audioEl, pc } once the server has answered. `audioEl`
 * (the one passed in, or a new detached <audio>) plays the stream. stop()
 * closes the peer connection and DELETEs the session; aborting `signal`
 * before then does the same.
 *
 * onState: 'connecting' | 'live' | 'disconnected' | 'failed' | 'closed' | 'blocked'
 * ('blocked': the browser wants a tap before it plays sound — the element's
 * own controls still work).
 */
export async function listen(streamId, { audioEl = null, onState, signal } = {}) {
  if (signal?.aborted) throw abortError()
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const el = audioEl || document.createElement('audio')
  el.autoplay = true
  let stopped = false
  let sessionUrl = null
  const cancelled = abortable()

  const stop = () => {
    if (stopped) return
    stopped = true
    signal?.removeEventListener('abort', stop)
    window.removeEventListener('pagehide', stop)
    cancelled.abort()
    try { pc.close() } catch {}
    try { el.pause() } catch {}
    el.srcObject = null
    closeSession(sessionUrl)
  }
  signal?.addEventListener('abort', stop)
  window.addEventListener('pagehide', stop)       // the tab closing ends the session too

  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.addEventListener('track', (ev) => {
    el.srcObject = ev.streams?.[0] || new MediaStream([ev.track])
    el.play?.()?.catch?.((err) => { if (err?.name === 'NotAllowedError') onState?.('blocked') })
  })
  watchConnection(pc, onState)
  onState?.('connecting')

  try {
    sessionUrl = await Promise.race([exchange(pc, streamUrl(streamId, 'listen'), () => stopped), cancelled.promise])
  } catch (err) {
    stop()
    throw err
  }
  return { stop, audioEl: el, pc }
}

/**
 * Publish this device's microphone as stream `streamId` (shown as `name`).
 *
 * Resolves to { stop, stream } once the server has answered. The browser's
 * echo cancellation and noise suppression are off: this mic is for hearing
 * the room — a dog, a doorbell, the sound detector — not for a call, and
 * "noise" is exactly what those filters remove.
 *
 * onState: 'connecting' | 'live' | 'disconnected' | 'failed' | 'closed' | 'ended'
 * ('ended': the mic itself stopped — unplugged, or permission withdrawn).
 */
export async function publishMic(streamId, name, { onState, signal } = {}) {
  if (signal?.aborted) throw abortError()
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('no getUserMedia'), {
      userMessage: 'This browser cannot share the microphone on this page (it needs https).',
    })
  }
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  })
  const track = media.getAudioTracks()[0]
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  let stopped = false
  let sessionUrl = null
  const cancelled = abortable()

  const stop = () => {
    if (stopped) return
    stopped = true
    signal?.removeEventListener('abort', stop)
    window.removeEventListener('pagehide', stop)
    cancelled.abort()
    try { pc.close() } catch {}
    media.getTracks().forEach(t => t.stop())
    closeSession(sessionUrl)
  }
  if (signal?.aborted) {
    stop()
    throw abortError()
  }
  signal?.addEventListener('abort', stop)
  window.addEventListener('pagehide', stop)       // the tab closing ends the broadcast too

  pc.addTransceiver(track, { direction: 'sendonly', streams: [media] })
  track.addEventListener('ended', () => { if (!stopped) onState?.('ended') })
  watchConnection(pc, onState)
  onState?.('connecting')

  const query = name ? `?name=${encodeURIComponent(name)}` : ''
  try {
    sessionUrl = await Promise.race([
      exchange(pc, `${streamUrl(streamId, 'publish')}${query}`, () => stopped),
      cancelled.promise,
    ])
  } catch (err) {
    stop()
    throw err
  }
  return { stop, stream: media }
}
