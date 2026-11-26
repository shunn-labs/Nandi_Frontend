// ═══════════════════════════════════════════════════════════
//  mediaHub.js  –  camera video to / from the media hub (mediamtx) over WebRTC
//
//  When the vision server has its media hub on, video no longer goes through
//  the vision server at all. The browser publishes its camera to the hub over
//  WebRTC (WHIP: one HTTP POST of an SDP offer) as H.264 from the device's
//  hardware encoder, and plays any stream from the hub the same way (WHEP).
//  The hub forwards the camera's own video without re-encoding, so a viewer
//  sees the camera's real resolution and frame rate, with WebRTC's congestion
//  control (a weak link lowers the bitrate instead of freezing). Annotated
//  views (<camera>_<task>) are streams the GPU backend publishes to the hub.
//
//  The vision server says whether to use this (GET /api/media/config ->
//  usable) and, per stream id, how to play it (GET /api/media/resolve/<id> ->
//  transport 'webrtc' | 'ws'). With the hub off, everything keeps using
//  visionFrames.js (JPEG over WebSocket).
//
//  publishCamera()  same API as visionFrames.startFrameProducer
//  playStream()     same API as visionFrames.startFrameConsumer, but it plays
//                   into a <video> element
// ═══════════════════════════════════════════════════════════

import { getVisionApiBase } from './endpoints.js'

const CONFIG_TTL_MS = 30000
const MAX_RECONNECT_DELAY = 15000
const ICE_GATHER_MAX_MS = 2000
const STALL_MS = 5000                 // no video for this long -> reconnect
const CONNECT_TIMEOUT_MS = 8000       // first publish: media must flow within this
const MEDIA_KEY_STORAGE = 'nandi_media_key'

let configCache = null                // { at, value }

function backoff(attempt) {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_DELAY)
  return Math.round(base * (0.7 + Math.random() * 0.6))
}

/** Optional key for a hub that requires one (MEDIA_CLIENT_KEY on the server). */
function mediaKey() {
  try {
    return localStorage.getItem(MEDIA_KEY_STORAGE) || import.meta.env.VITE_VISION_MEDIA_KEY || ''
  } catch {
    return import.meta.env.VITE_VISION_MEDIA_KEY || ''
  }
}

/** The vision server's media settings; { usable: false } when it can't be reached. */
export async function getMediaConfig(force = false) {
  if (!force && configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value
  let value = { enabled: false, usable: false }
  try {
    const r = await fetch(`${getVisionApiBase()}/api/media/config`, { cache: 'no-store' })
    if (r.ok) value = await r.json()
  } catch { /* an old vision server or offline: stay on the WebSocket path */ }
  configCache = { at: Date.now(), value }
  return value
}

/** How to play one stream id: { transport: 'webrtc' | 'ws', whep }. */
export async function resolveStream(streamId) {
  try {
    const r = await fetch(`${getVisionApiBase()}/api/media/resolve/${encodeURIComponent(streamId)}`,
      { cache: 'no-store' })
    if (r.ok) return await r.json()
  } catch { /* fall through */ }
  return { transport: 'ws', whep: '' }
}

function preferH264(transceiver) {
  // H.264 first: every phone and laptop encodes it in hardware, the GPU decodes
  // it with NVDEC, and every viewer can play it.
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')?.codecs || []
    const h264 = caps.filter(c => /h264/i.test(c.mimeType))
    if (!h264.length) return
    const rank = (c) => (/packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1)
      + (/profile-level-id=42e0/.test(c.sdpFmtpLine || '') ? 0 : 1)
    h264.sort((a, b) => rank(a) - rank(b))
    transceiver.setCodecPreferences([...h264, ...caps.filter(c => !/h264/i.test(c.mimeType))])
  } catch { /* setCodecPreferences missing (old Safari): the browser picks */ }
}

function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve() }
    const check = () => { if (pc.iceGatheringState === 'complete') done() }
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(done, ICE_GATHER_MAX_MS)
  })
}

/**
 * Chrome's congestion control starts a new video sender at ~300 kbit/s and
 * climbs for ~20 s (480x270 -> 720p) even on a fast link. Starting from the
 * hub's answer with a higher start bitrate gets the full picture in a second
 * or two; congestion control still lowers it on a slow link.
 */
function withStartBitrate(sdp, kbps) {
  const lines = sdp.split('\r\n')
  const video = new Set()
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\/90000/i.exec(l)
    if (m) video.add(m[1])
  }
  return lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (!m || !video.has(m[1]) || /x-google-start-bitrate/.test(l)) return l
    return `${l};x-google-start-bitrate=${kbps}`
  }).join('\r\n')
}

/** POST the offer (WHIP or WHEP); returns { answer, location } or throws {status}. */
async function exchange(url, pc, { startKbps = 0 } = {}) {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitIceGathering(pc)
  const headers = { 'Content-Type': 'application/sdp' }
  const key = mediaKey()
  if (key) headers.Authorization = `Bearer ${key}`
  let r
  try {
    r = await fetch(url, { method: 'POST', headers, body: pc.localDescription.sdp })
  } catch (err) {
    // DNS, TLS or the network: name the host, so the reason means something
    // where it is shown (this device's Devices panel, the vision server's log).
    throw new Error(`could not reach the media hub at ${new URL(url).host} (${err.message})`)
  }
  if (r.status !== 201 && r.status !== 200) {
    const err = new Error(`media hub answered ${r.status}`)
    err.status = r.status
    throw err
  }
  let answer = await r.text()
  if (startKbps) answer = withStartBitrate(answer, startKbps)
  const loc = r.headers.get('Location')
  await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  return { location: loc ? new URL(loc, url).toString() : null }
}

function connected(pc, timeoutMs) {
  if (pc.connectionState === 'connected') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error('no media connection to the hub')) }, timeoutMs)
    const on = () => {
      if (pc.connectionState === 'connected') { off(); resolve() }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        off(); reject(new Error(`media connection ${pc.connectionState}`))
      }
    }
    const off = () => { clearTimeout(t); pc.removeEventListener('connectionstatechange', on) }
    pc.addEventListener('connectionstatechange', on)
  })
}

/**
 * End a WHIP/WHEP session: DELETE it first, then close the peer connection.
 * Closing first makes the hub drop the session on its own, so the DELETE
 * that follows is answered 404 (and the browser logs it as an error).
 */
function hangUp(location, pc) {
  const shut = () => { try { pc?.close() } catch { /* already closed */ } }
  if (!location) { shut(); return }
  const key = mediaKey()
  const req = fetch(location, { method: 'DELETE', headers: key ? { Authorization: `Bearer ${key}` } : {} })
    .catch(() => {})
  Promise.race([req, new Promise(r => setTimeout(r, 1000))]).then(shut)
}

// ════════════════════════ PUBLISHER ════════════════════════

/**
 * Publish this device's camera to the hub as `streamId`.
 * Same shape as startFrameProducer: getStream, getFacingMode, switchCamera,
 * onStreamChange, close, getStats.
 */
export async function publishCamera({ streamId, facingMode = 'environment', callbacks = {} } = {}) {
  const { onState, onLog } = callbacks
  const log = (text, type = 'info') => onLog?.(text, type)
  const cfg = await getMediaConfig()
  if (!cfg.usable || !cfg.whip) throw new Error('the media hub is not available')
  const url = cfg.whip.replace('{stream}', encodeURIComponent(streamId))

  let currentStream = null
  let currentFacing = facingMode
  let pc = null
  let sender = null
  let location = null
  let closed = false
  let attempts = 0
  let reconnectTimer = null
  const streamListeners = []

  async function acquire(mode) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 },
               frameRate: { ideal: 30 } },
      audio: false,
    })
    const track = stream.getVideoTracks()[0]
    if (track && 'contentHint' in track) track.contentHint = 'motion'   // keep the frame rate
    return stream
  }

  function bitrateFor(track) {
    const s = track?.getSettings?.() || {}
    const px = (s.width || 1280) * (s.height || 720)
    return Math.round(Math.min(8e6, Math.max(1.5e6, 4e6 * px / (1280 * 720))))
  }

  function scheduleReconnect(why) {
    if (closed || reconnectTimer) return
    attempts += 1
    const delay = backoff(attempts)
    log(`Publish ${why} — reconnecting in ${Math.round(delay / 1000)}s`, 'warn')
    onState?.('disconnected')
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
  }

  async function connect(throwOnFail = false) {
    if (closed) return
    hangUp(location, pc)
    pc = null
    location = null
    const me = new RTCPeerConnection({ iceServers: cfg.ice_servers || [], bundlePolicy: 'max-bundle' })
    pc = me
    const track = currentStream.getVideoTracks()[0]
    const tr = me.addTransceiver(track, {
      direction: 'sendonly',
      streams: [currentStream],
      sendEncodings: [{ maxBitrate: bitrateFor(track), maxFramerate: 30 }],
    })
    sender = tr.sender
    preferH264(tr)
    me.addEventListener('connectionstatechange', () => {
      if (pc !== me) return
      const st = me.connectionState
      if (st === 'connected') { attempts = 0; onState?.('live'); log('Publishing to the media hub', 'ok') }
      else if (st === 'failed' || st === 'closed') scheduleReconnect(st)
      else if (st === 'disconnected') {
        setTimeout(() => { if (pc === me && me.connectionState === 'disconnected') scheduleReconnect('lost') }, STALL_MS)
      }
    })
    try {
      onState?.('connecting')
      const res = await exchange(url, me, { startKbps: Math.round(bitrateFor(track) * 0.6 / 1000) })
      if (pc !== me) { hangUp(res.location, me); return }
      location = res.location
      // First attempt: the SDP exchange worked, but media also has to flow (UDP or
      // TCP to the hub's WebRTC port may be blocked on this network).
      if (throwOnFail) await connected(me, CONNECT_TIMEOUT_MS)
    } catch (err) {
      if (throwOnFail) {
        hangUp(location, me)
        location = null
        pc = null
        throw err
      }
      if (pc === me) scheduleReconnect(`failed (${err.message})`)
    }
  }

  currentStream = await acquire(currentFacing)
  log(`Got camera (${currentFacing})`, 'ok')
  try {
    // The first attempt must work, so the caller can fall back to the
    // WebSocket producer if the hub can't be reached from this network.
    await connect(true)
  } catch (err) {
    currentStream.getTracks().forEach(t => t.stop())
    throw err
  }

  async function switchCamera() {
    const next = currentFacing === 'environment' ? 'user' : 'environment'
    const stream = await acquire(next)
    const old = currentStream
    currentFacing = next
    currentStream = stream
    // Same WebRTC session, new camera: no reconnect, viewers keep playing.
    try { await sender?.replaceTrack(stream.getVideoTracks()[0]) } catch { connect() }
    old?.getTracks().forEach(t => t.stop())
    streamListeners.forEach(cb => cb(stream))
    log(`Switched to ${next}`, 'ok')
    return next
  }

  function onStreamChange(cb) {
    streamListeners.push(cb)
    return () => {
      const i = streamListeners.indexOf(cb)
      if (i >= 0) streamListeners.splice(i, 1)
    }
  }

  function close() {
    closed = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    currentStream?.getTracks().forEach(t => t.stop())     // the camera goes off right away
    hangUp(location, pc)
    location = null
    pc = null
  }

  async function getStats() {
    const out = { transport: 'webrtc', state: pc?.connectionState || 'closed' }
    try {
      const report = await sender?.getStats()
      report?.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          Object.assign(out, { fps: s.framesPerSecond, width: s.frameWidth, height: s.frameHeight,
            bytesSent: s.bytesSent, limitation: s.qualityLimitationReason })
        }
      })
    } catch { /* no stats yet */ }
    return out
  }

  return {
    transport: 'webrtc',
    path: 'hub',
    getStream: () => currentStream,
    getFacingMode: () => currentFacing,
    switchCamera,
    onStreamChange,
    close,
    getStats,
  }
}

// ════════════════════════ PLAYER ════════════════════════

/**
 * Play `streamId` from the hub into `video`. onState: 'connecting' | 'waiting'
 * (the hub has no such stream yet — retrying) | 'live' | 'offline'.
 * Returns { close, refresh, getStats }.
 */
export function playStream(streamId, video, { whep, onState } = {}) {
  let closed = false
  let pc = null
  let location = null
  let attempts = 0
  let timer = null
  let stallTimer = null

  function clearTimers() {
    if (timer) { clearTimeout(timer); timer = null }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  }

  function retry(state, delay) {
    if (closed) return
    onState?.(state)
    clearTimers()
    timer = setTimeout(() => { timer = null; connect() }, delay)
  }

  async function connect() {
    if (closed) return
    clearTimers()
    hangUp(location, pc)
    pc = null
    location = null

    const cfg = await getMediaConfig()
    const url = whep || (cfg.whep || '').replace('{stream}', encodeURIComponent(streamId))
    if (!url) { retry('offline', backoff(++attempts)); return }
    const me = new RTCPeerConnection({ iceServers: cfg.ice_servers || [], bundlePolicy: 'max-bundle' })
    pc = me
    me.addTransceiver('video', { direction: 'recvonly' })
    me.addTransceiver('audio', { direction: 'recvonly' })
    me.addEventListener('track', (e) => {
      if (pc !== me || e.track.kind !== 'video') return
      video.srcObject = new MediaStream([e.track])
      video.play?.().catch(() => {})
      // No media for a while (the publisher went away): reconnect.
      e.track.addEventListener('mute', () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => { if (pc === me) retry('offline', 500) }, STALL_MS)
      })
      e.track.addEventListener('unmute', () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
        onState?.('live')
      })
    })
    me.addEventListener('connectionstatechange', () => {
      if (pc !== me) return
      const st = me.connectionState
      if (st === 'connected') { attempts = 0; onState?.('live') }
      else if (st === 'failed' || st === 'closed') retry('offline', backoff(++attempts))
      else if (st === 'disconnected') {
        stallTimer = setTimeout(() => { if (pc === me && me.connectionState === 'disconnected') retry('offline', 500) }, STALL_MS)
      }
    })
    try {
      onState?.('connecting')
      const res = await exchange(url, me)
      if (pc !== me) { hangUp(res.location, me); return }
      location = res.location
    } catch (err) {
      if (pc !== me) return
      // 404: nobody publishes this stream (yet) — an annotated view takes a
      // second or two to start; a camera may still be connecting.
      if (err.status === 404) retry('waiting', ++attempts <= 10 ? 1000 : 3000)
      else retry('offline', backoff(++attempts))
    }
  }

  connect()

  return {
    transport: 'webrtc',
    close() {
      closed = true
      clearTimers()
      hangUp(location, pc)
      location = null
      pc = null
      if (video) video.srcObject = null
    },
    refresh() { attempts = 0; connect() },
    async getStats() {
      const out = { transport: 'webrtc', state: pc?.connectionState || 'closed' }
      try {
        const report = await pc?.getStats()
        report?.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            Object.assign(out, { fps: s.framesPerSecond, width: s.frameWidth, height: s.frameHeight,
              bytesReceived: s.bytesReceived, framesDropped: s.framesDropped, jitter: s.jitter })
          }
        })
      } catch { /* no stats yet */ }
      return out
    },
  }
}
