// ═══════════════════════════════════════════════════════════
//  voiceSession.js  –  a real-time voice conversation with Nandi
//
//  A thin wrapper around the official Pipecat client (PipecatClient +
//  SmallWebRTCTransport) talking to the audio server's POST /v1/voice/offer
//  (PATCH for trickle ICE). The server runs the whole loop — speech-to-text,
//  turn detection, the brain over its own /ws/chat socket, text-to-speech —
//  and streams Nandi's voice back on the same peer connection, so this side
//  only has to:
//
//    * connect with the brain JWT and this browser's client_id, so the brain
//      treats a voice turn as coming from this device (display pushes land
//      here, like for typed chat),
//    * play the bot's audio track and measure both sides' levels for the core,
//    * turn RTVI events into a small state machine for the UI:
//        idle → connecting → listening ⇄ thinking ⇄ speaking, or error,
//    * and hand every finished exchange (what the user said, what Nandi
//      answered) to onTurn — voice turns go through the audio server's brain
//      socket, so the browser's chat socket never sees them.
//
//  Nandi's custom RTVI server messages (voice/brain_bridge.py on the server):
//    {type:"nandi.state", state:"thinking", request_id}   a turn went to the brain
//    {type:"nandi.progress", text, request_id}            "Checking the gate camera…"
//    {type:"nandi.engines", stt, tts, voice}              "local" | "elevenlabs"; voice = "Aiden" | "ElevenLabs"
//    {type:"nandi.notice", text}                          a reply couldn't be spoken, and why
//    {type:"nandi.turn", request_id, status}              the brain finished the turn
//  Typed text during a session goes up as the client message "nandi.text".
// ═══════════════════════════════════════════════════════════

import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'
import { AUDIO_OFFER_URL } from './endpoints.js'
import { audioHost } from './audioApi.js'
import { getClientId, getDeviceName } from './clientId.js'
import { stripEmotionTag } from './emotionTag.js'

// Same public STUN as the camera streams. Without any ICE server the browser
// offers only host candidates, which is not enough behind most NATs.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Starting the mic includes loading the transport's device manager, so this
// is generous; past it the user gets a reason instead of an endless spinner.
const DEVICE_INIT_TIMEOUT_MS = 25000
// The transport retries a failed offer 3 times, ~2 s apart, before giving up.
const CONNECT_TIMEOUT_MS = 30000
// After Nandi's last word, how long the reply must stay quiet before a turn
// whose text only came from her speech counts as finished.
const SETTLE_MS = 1200
// The brain has answered: how long to wait for her to start speaking it.
const UNSPOKEN_MS = 4000

const CONNECTED_STATES = new Set(['listening', 'thinking', 'speaking'])

// bot-output kinds that are not words of the reply.
const SKIP_OUTPUT = new Set(['backchannel', 'expression_sound', 'expression_pause'])

function voiceError(code, message, cause) {
  return Object.assign(new Error(message), { code, cause })
}

function withTimeout(promise, ms, error) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(error), ms) }),
  ]).finally(() => clearTimeout(timer))
}

function closeContext(ctx) {
  try { ctx?.close?.()?.catch?.(() => {}) } catch {}
}

/**
 * Ask for the microphone up front. A refusal is then a clear DOMException
 * here; inside the transport it is only an event, and the connect that
 * started it would wait for a mic that never comes.
 */
async function ensureMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw voiceError('mic', 'This browser cannot use the microphone on this page (it needs https).')
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(t => t.stop())
  } catch (err) {
    const name = err?.name
    if (name === 'NotAllowedError' || name === 'SecurityError' || /permission/i.test(err?.message || '')) {
      throw voiceError('mic', 'Microphone blocked. Allow mic access for this site, then try again.', err)
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw voiceError('mic', 'No microphone found.', err)
    }
    if (name === 'NotReadableError') {
      throw voiceError('mic', 'The microphone is in use by another app.', err)
    }
    throw voiceError('mic', `The microphone failed: ${err?.message || name || 'unknown error'}`, err)
  }
}

function micStateError(mic) {
  switch (mic?.reason) {
    case 'blocked': return voiceError('mic', 'Microphone blocked. Allow mic access for this site, then try again.')
    case 'not-found': return voiceError('mic', 'No microphone found.')
    case 'already-in-use': return voiceError('mic', 'The microphone is in use by another app.')
    default: return voiceError('mic', 'The microphone could not be started.')
  }
}

/** What went wrong with the offer, in words — the transport only says "rejected with status N". */
async function connectError(err) {
  if (err?.code) return err
  const response = err?.cause instanceof Response ? err.cause : (err instanceof Response ? err : null)
  const status = err?.status ?? response?.status
  if (response) {
    try {
      const body = await response.clone().json()
      if (body?.detail) console.warn(`[voice] offer refused (${status}): ${body.detail}`)
    } catch { /* no JSON body */ }
  }
  if (status === 401) return voiceError('auth', 'Your session has expired — sign in again to use voice.', err)
  if (status === 429) return voiceError('busy', 'Voice is busy right now — too many conversations are running. Try again in a minute.', err)
  if (status === 403) return voiceError('forbidden', 'The voice server refused this connection.', err)
  if (status >= 500) return voiceError('server', `The voice server ran into a problem (HTTP ${status}). Try again shortly.`, err)
  if (status >= 400) return voiceError('refused', `The voice server refused the connection (HTTP ${status}).`, err)
  console.warn('[voice] connect failed:', err)
  return voiceError('network', `Can't reach the voice server (${audioHost()}).`, err)
}

function newTurn(id, user, typed) {
  return {
    id, user, typed,
    llm: '',                 // the reply as the brain streamed it (complete when the turn ends)
    segments: new Map(),     // the reply as spoken, sentence by sentence (segment_id → text)
    spoke: false,
    brainDone: false,
    interrupted: false,
    status: '',
    error: '',
    done: false,             // handed to onTurn
  }
}

function spokenText(turn) {
  return [...turn.segments.values()].map(s => s.trim()).filter(Boolean).join(' ')
}

export class VoiceSession {
  /**
   * handlers (all optional):
   *   onState(state)            idle | connecting | listening | thinking | speaking | error
   *   onUserText(text)          what the user is saying (live) or the utterance being answered
   *   onBotText(text)           Nandi's reply so far, as she speaks it (emotion tag removed)
   *   onProgress(text)          the brain's latest progress line, '' when there is none
   *   onEngines({stt, tts})     'local' | 'elevenlabs' for each
   *   onLevels({mic, bot})      0..1-ish levels, many times a second
   *   onTurn({id, user, reply, status, error, typed})   one finished exchange
   *   onError(error)            error.message is shown to the user; error.code says what kind
   *   onAudioBlocked(blocked)   the browser refused to start Nandi's audio without a tap
   *
   * options.audioElement: a hidden <audio autoplay> for Nandi's voice; one is
   * created (and removed again) if it is not given.
   */
  constructor(handlers = {}, { audioElement = null } = {}) {
    this.h = handlers
    this.state = 'idle'
    this.error = null
    this.client = null
    this.gen = 0              // bumps on every connect and teardown; stale callbacks compare against it
    this.disposed = false
    this.failed = false
    this.audioEl = audioElement
    this.ownAudioEl = false
    this.botTrack = null
    this.meter = null
    this.muted = false
    this.duplex = 'full'
    this.botSpeaking = false
    this.turn = null
    this.utterance = ''       // final transcripts of what the user is saying now
    this.interim = ''
    this.lastUserLlm = ''     // the exact utterance the server handed to the brain
    this.typed = []           // typed messages waiting for their turn to start
    this.sawUserInput = false
    this.segSeq = 0
    this.timer = null
    this.micLevel = 0
    this.botLevel = 0
    // Closing the tab must end the session on the server at once: left to the
    // peer connection timing out it would hold one of the server's few voice
    // slots for a while.
    this._onPageHide = () => {
      if (this.client) this._fail(voiceError('ended', 'The voice session ended.'))
    }
  }

  // ── public ────────────────────────────────────────────────

  get connected() {
    return CONNECTED_STATES.has(this.state)
  }

  async connect({ lang = 'auto', duplex = 'full' } = {}) {
    if (this.disposed || this.client) return
    const token = localStorage.getItem('user_token')
    if (!token) {
      this._fail(voiceError('auth', 'Sign in to use voice.'))
      return
    }

    const gen = ++this.gen
    this.failed = false
    this.error = null
    this.duplex = duplex === 'half' ? 'half' : 'full'
    this._setState('connecting')

    try {
      await ensureMicPermission()
      if (gen !== this.gen) return

      const client = new PipecatClient({
        transport: new SmallWebRTCTransport({ iceServers: ICE_SERVERS }),
        enableMic: true,
        enableCam: false,
        callbacks: this._callbacks(gen),
      })
      this.client = client
      window.addEventListener('pagehide', this._onPageHide)

      // Done here rather than left to connect(): inside connect() this step
      // runs outside its error handling, and a failure would leave the
      // promise pending forever.
      await withTimeout(client.initDevices(), DEVICE_INIT_TIMEOUT_MS,
        voiceError('device', 'The microphone did not start in time. Check your connection and try again.'))
      if (gen !== this.gen) return
      if (client.mediaState?.mic?.state === 'error') throw micStateError(client.mediaState.mic)

      await withTimeout(client.connect({
        webrtcRequestParams: {
          endpoint: AUDIO_OFFER_URL,
          // A Headers object, not a plain one: the transport copies it with
          // .entries() for the offer and for every trickle-ICE PATCH.
          headers: new Headers({ Authorization: `Bearer ${token}` }),
          requestData: {
            client_id: getClientId(),
            device_name: getDeviceName(),
            lang,
            duplex: this.duplex,
          },
        },
      }), CONNECT_TIMEOUT_MS, voiceError('timeout', "The voice server didn't answer in time. Try again."))
      if (gen !== this.gen) return

      if (this.muted) client.enableMic(false)
      this._setState(this.botSpeaking ? 'speaking' : 'listening')
    } catch (err) {
      if (gen !== this.gen || this.failed) return
      this._fail(await connectError(err))
    }
  }

  /** End the session; the instance can connect() again. */
  async disconnect() {
    this._finishTurn()
    await this._teardown()
    if (!this.disposed) this._setState('idle')
  }

  /** End the session for good and stop calling handlers (the UI is going away). */
  dispose() {
    if (this.disposed) return
    this._finishTurn()      // the exchange in progress still belongs in the chat
    this.disposed = true
    this._teardown()
  }

  setMuted(muted) {
    this.muted = !!muted
    if (this.client?.connected) this.client.enableMic(!this.muted)
    if (this.muted) this._level('mic', 0)
    return this.muted
  }

  /** Type to Nandi during the session; she answers out loud. False if it could not be sent. */
  sendText(text) {
    const t = (text || '').trim()
    if (!t || !this.connected || !this.client?.connected) return false
    try {
      this.client.sendClientMessage('nandi.text', { text: t })
    } catch (err) {
      console.warn('[voice] typed message not sent:', err)
      return false
    }
    this.typed.push(t)
    if (!this.turn || this.turn.done) this._clearReply()
    this.h.onUserText?.(t)
    return true
  }

  /** Retry Nandi's audio after the browser blocked autoplay (call from a click). */
  resumeAudio() {
    this.meter?.ctx?.resume?.().catch(() => {})
    const played = this.audioEl?.play?.()
    played?.then?.(() => this.h.onAudioBlocked?.(false)).catch(() => {})
  }

  // ── Pipecat callbacks ────────────────────────────────────

  _callbacks(gen) {
    // The transport's device manager shares one call object per page, so a
    // client from an earlier connect can still fire. Only the current one counts.
    const live = (fn) => (...args) => {
      if (gen === this.gen && !this.disposed) fn(...args)
    }
    return {
      onBotReady: live(() => console.info('[voice] connected to', AUDIO_OFFER_URL)),
      onDisconnected: live(() => this._lost()),
      onError: live((msg) => {
        const data = msg?.data || {}
        console.warn('[voice] error:', data.error || data.message || msg)
        if (data.fatal && this.connected) this._fail(voiceError('server', 'The voice session stopped on the server.'))
      }),
      onDeviceError: live((err) => {
        if (!err?.devices?.includes?.('mic')) return
        const reason = { permissions: 'blocked', 'not-found': 'not-found', 'in-use': 'already-in-use' }[err.type]
        this._fail(micStateError({ reason }))
      }),
      onTrackStarted: live((track, participant) => {
        if (track?.kind === 'audio' && !participant?.local) this._playBot(track)
      }),
      onLocalAudioLevel: live((level) => this._level('mic', this.muted ? 0 : level)),
      // Not emitted by this transport today (it has no audio player of its
      // own); the bot track is measured in _startMeter instead.
      onRemoteAudioLevel: live((level) => { if (!this.meter) this._level('bot', level) }),
      onUserStartedSpeaking: live(() => this._userStarted()),
      onUserInput: live((d) => {
        this.sawUserInput = true
        if (!d?.input_type || d.input_type === 'transcription') this._userText(d?.text, d?.final)
      }),
      // Older servers only send user-transcription.
      onUserTranscript: live((d) => { if (!this.sawUserInput) this._userText(d?.text, d?.final) }),
      onUserLlmText: live((d) => { this.lastUserLlm = String(d?.text || '').trim() }),
      onBotStartedSpeaking: live(() => this._botStarted()),
      onBotStoppedSpeaking: live(() => this._botStopped()),
      onBotInterrupted: live(() => this._botInterrupted()),
      onBotOutput: live((d) => this._botOutput(d)),
      // The reply as the brain streamed it, deltas with their own spacing: the
      // complete text as soon as the brain is done, however far the voice is.
      onBotLlmText: live((d) => { if (this.turn && !this.turn.done) this.turn.llm += String(d?.text || '') }),
      onServerMessage: live((m) => this._serverMessage(m)),
    }
  }

  // ── the user ─────────────────────────────────────────────

  _userStarted() {
    // With barge-in the server drops the turn in progress when the user talks
    // over it; in half duplex it keeps going and this utterance waits.
    const t = this.turn
    if (t && !t.done && this.duplex === 'full') t.interrupted = true
    if (!this.botSpeaking && (this.duplex === 'full' || !t || t.brainDone)) this._setState('listening')
  }

  _userText(text, final) {
    const t = String(text || '').trim()
    if (!t && !final) return
    const fresh = !this.utterance && !this.interim
    if (final) {
      if (t) this.utterance = this.utterance ? `${this.utterance} ${t}` : t
      this.interim = ''
    } else {
      this.interim = t
    }
    if (fresh && (!this.turn || this.turn.done)) this._clearReply()
    this.h.onUserText?.([this.utterance, this.interim].filter(Boolean).join(' '))
  }

  // ── turns ────────────────────────────────────────────────

  _serverMessage(m) {
    if (!m || typeof m !== 'object') return
    const t = this.turn
    const isCurrent = t && (!m.request_id || !t.id || m.request_id === t.id)
    switch (m.type) {
      case 'nandi.state':
        if (m.state === 'thinking' && (!t || m.request_id !== t.id)) this._startTurn(m.request_id || null)
        break
      case 'nandi.progress':
        if (isCurrent && !t.brainDone) this.h.onProgress?.(String(m.text || ''))
        break
      case 'nandi.engines':
        this.h.onEngines?.({ stt: String(m.stt || ''), tts: String(m.tts || ''), voice: String(m.voice || '') })
        break
      case 'nandi.notice':
        if (m.text) this.h.onNotice?.(String(m.text))
        break
      case 'nandi.turn':
        if (isCurrent && !t.brainDone) this._brainDone(m)
        break
      default:
    }
  }

  _startTurn(id) {
    this._finishTurn()
    const typed = this.typed.length > 0
    const said = [this.utterance, this.interim].filter(Boolean).join(' ')
    const user = typed ? this.typed.shift() : (this.lastUserLlm || said)
    this.utterance = ''
    this.interim = ''
    this.lastUserLlm = ''
    this.turn = newTurn(id, user, typed)
    clearTimeout(this.timer)
    this.h.onUserText?.(user)
    this._clearReply()
    this._setState('thinking')
  }

  _brainDone(m) {
    const t = this.turn
    t.brainDone = true
    t.status = String(m.status || '')
    t.error = m.error ? String(m.error) : ''
    this.h.onProgress?.('')
    // The whole reply is known now, even if she is still saying it.
    if (t.llm.trim()) this._finishTurn()
    if (this.botSpeaking) return
    if (t.spoke) {
      this._setState('listening')
      this._later(SETTLE_MS, () => { if (!this.botSpeaking) this._finishTurn(t) })
    } else {
      // Answered, not spoken yet: text-to-speech is usually a moment behind.
      this._later(UNSPOKEN_MS, () => {
        if (this.botSpeaking || this.turn !== t) return
        if (!t.segments.size && t.llm.trim()) this.h.onBotText?.(stripEmotionTag(t.llm).trim())
        this._finishTurn(t)
        this._setState('listening')
      })
    }
  }

  _finishTurn(t = this.turn) {
    if (!t || t.done) return
    t.done = true
    clearTimeout(this.timer)
    const reply = stripEmotionTag(t.llm.trim() ? t.llm : spokenText(t)).trim()
    const status = t.status || (t.interrupted ? 'interrupted' : '')
    if (t.user || reply) {
      this.h.onTurn?.({ id: t.id, user: t.user, reply, status, error: t.error, typed: t.typed })
    }
  }

  _clearReply() {
    this.h.onBotText?.('')
    this.h.onProgress?.('')
  }

  _later(ms, fn) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (!this.disposed) fn() }, ms)
  }

  // ── Nandi ────────────────────────────────────────────────

  _botStarted() {
    this.botSpeaking = true
    clearTimeout(this.timer)
    if (this.turn) this.turn.spoke = true
    this._setState('speaking')
  }

  _botStopped() {
    this.botSpeaking = false
    const t = this.turn
    if (t && !t.brainDone && !t.done) {
      // A filler ("Checking the gate camera.") or the first sentences: the
      // brain is still working on the rest.
      this._setState('thinking')
      return
    }
    this._setState('listening')
    if (t && !t.done) this._later(SETTLE_MS, () => { if (!this.botSpeaking) this._finishTurn(t) })
  }

  _botInterrupted() {
    this.botSpeaking = false
    if (this.turn && !this.turn.done) this.turn.interrupted = true
    this._setState('listening')
  }

  _botOutput(d) {
    if (!d) return
    if (SKIP_OUTPUT.has(d.output_type || d.aggregated_by || d.text_type)) return
    if (!this.turn) {
      // Spoken outside any turn (an announcement): shown, never recorded.
      this.turn = newTurn(null, '', false)
      this.turn.done = true
      this.turn.brainDone = true
    }
    const t = this.turn
    // Each sentence comes twice — announced as it starts, again once spoken —
    // under one segment_id. spoken_progress, when present, holds the whole
    // segment (said so far + still to say).
    const id = d.segment_id ?? `seg${++this.segSeq}`
    const p = d.spoken_progress
    const full = p ? `${p.accumulated_text || ''}${p.remaining_text || ''}` : String(d.text || '')
    if (!full.trim()) return
    const before = t.segments.get(id)
    if (before === undefined || (d.spoken_status === 'completed' && full.length >= before.length)) {
      t.segments.set(id, full)
    }
    this.h.onBotText?.(stripEmotionTag(spokenText(t)).trim())
  }

  _playBot(track) {
    if (this.botTrack === track) return
    this.botTrack = track
    const stream = new MediaStream([track])
    if (!this.audioEl) {
      const el = document.createElement('audio')
      el.autoplay = true
      el.setAttribute('playsinline', '')
      el.hidden = true
      document.body.appendChild(el)
      this.audioEl = el
      this.ownAudioEl = true
    }
    this.audioEl.srcObject = stream
    const played = this.audioEl.play?.()
    played?.then?.(() => this.h.onAudioBlocked?.(false)).catch((err) => {
      if (err?.name === 'NotAllowedError') this.h.onAudioBlocked?.(true)
    })
    this._startMeter(stream)
  }

  // The transport reports the mic's level but not the bot's, so Nandi's voice
  // is measured here, off the same stream the <audio> element plays.
  _startMeter(stream) {
    this._stopMeter()
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    try {
      const ctx = new AC()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      ctx.resume?.().catch(() => {})
      const data = new Uint8Array(analyser.fftSize)
      const meter = { ctx, raf: 0 }
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        this._level('bot', Math.sqrt(sum / data.length))
        meter.raf = requestAnimationFrame(tick)
      }
      meter.raf = requestAnimationFrame(tick)
      this.meter = meter
    } catch (err) {
      console.warn('[voice] cannot measure Nandi’s voice level:', err)
    }
  }

  _stopMeter() {
    if (!this.meter) return
    cancelAnimationFrame(this.meter.raf)
    closeContext(this.meter.ctx)
    this.meter = null
  }

  _level(kind, value) {
    // Coerced: the transport's mic level arrives as a string ("0.246471").
    const n = Number(value)
    const v = Number.isFinite(n) ? n : 0
    if (kind === 'mic') this.micLevel = v
    else this.botLevel = v
    this.h.onLevels?.({ mic: this.micLevel, bot: this.botLevel })
  }

  // ── lifecycle ────────────────────────────────────────────

  _setState(state) {
    if (this.disposed || this.state === state) return
    this.state = state
    this.h.onState?.(state)
  }

  /** The peer connection went away without us asking (idle timeout, server restart, network). */
  _lost() {
    if (!this.connected) return     // connect() reports its own failures
    this._fail(voiceError('ended', 'The voice session ended.'))
  }

  _fail(error) {
    if (this.failed) return
    this.failed = true
    this._finishTurn()
    this._teardown()
    this.error = error
    this._setState('error')
    if (!this.disposed) this.h.onError?.(error)
  }

  async _teardown() {
    this.gen++
    clearTimeout(this.timer)
    this._stopMeter()
    this.botSpeaking = false
    // Nothing said or typed before this point can start a turn any more.
    this.typed = []
    this.utterance = ''
    this.interim = ''
    this.lastUserLlm = ''
    if (this.audioEl) {
      try { this.audioEl.pause() } catch {}
      this.audioEl.srcObject = null
      if (this.ownAudioEl) {
        this.audioEl.remove()
        this.audioEl = null
        this.ownAudioEl = false
      }
    }
    this.botTrack = null
    this._level('mic', 0)
    this._level('bot', 0)
    window.removeEventListener('pagehide', this._onPageHide)
    const client = this.client
    this.client = null
    if (client) {
      // disconnect() closes the peer connection before its first await, so
      // this still reaches the server when it runs from pagehide.
      try { await client.disconnect() } catch (err) { console.warn('[voice] disconnect:', err) }
    }
  }
}
