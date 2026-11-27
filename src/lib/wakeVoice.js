// ═══════════════════════════════════════════════════════════
//  wakeVoice.js  –  voice mode that behaves like the Raspberry Pi client
//
//  Wraps a VoiceSession (the WebRTC conversation) and a WakeListener
//  ("hey Nandi" on this device) in the Pi client's turn-taking
//  (Nandi_Voice_Client v2, nandi_voice/turns.py), adapted to WebRTC, where
//  the audio server still decides when a sentence ends:
//
//    SLEEPING   mic closed to the server; only the wake word runs
//       │  "hey Nandi" / "hi Nandi" (or a tap)            → wake beep
//    LISTEN     mic open; nothing said within 6 s          → sleep beep → SLEEPING
//       │  the server hears speech
//    HEARING    the server's VAD + Smart Turn end the sentence
//       │  the turn goes to the brain
//    REPLYING   mic closed again (room talk can't interrupt); the wake word runs:
//       │       "hey Nandi" ducks her voice and opens the mic → LISTEN, and
//       │       what you say next interrupts her (full duplex)
//       │  the reply is over
//    FOLLOW-UP  mic open for 15 s, no wake word needed      → silence: sleep beep → SLEEPING
//
//  With the wake word off the mic simply stays open (the old behaviour).
//  Either way the conversation survives drops and the server's idle timeout:
//  it reconnects with the Pi's backoff (1, 2, 4, 8, 16, 30 s) until voice
//  mode is ended.
// ═══════════════════════════════════════════════════════════

import { VoiceSession } from './voiceSession.js'
import { WakeListener } from './wakeword/wakeListener.js'
import { playBeep } from './beeps.js'

export const PHASE = {
  OPEN: 'open',              // no wake word: always listening
  SLEEPING: 'sleeping',
  LISTEN: 'listen',
  HEARING: 'hearing',
  REPLYING: 'replying',
  FOLLOWUP: 'followup',
}

const LISTEN_S = 6           // after the wake word, how long to wait for speech
const NOTHING_HEARD_S = 8    // the user stopped and no turn started
const REPLY_TIMEOUT_S = 120
const BACKOFF_S = [1, 2, 4, 8, 16, 30]
// Errors a retry can't fix: the user must act (sign in, allow the mic).
const FATAL = new Set(['auth', 'mic', 'forbidden'])

export class WakeVoice {
  /**
   * handlers: everything VoiceSession takes (onState, onUserText, onBotText, …,
   * onError, onAudioBlocked), plus
   *   onPhase(phase, { until })   wake phase; `until` = ms timestamp a timed phase ends
   *   onWakeScore(score)          the wake detector's score per 80 ms frame
   *   onWakeReady(ok, error)      the wake-word model loaded (or failed: tap-to-talk still works)
   *   onReconnect({ inS, attempt })  lost the session; retrying in `inS` seconds
   * options: { wake: bool, threshold: number|null, followupS: number, beeps: bool, audioElement }
   */
  constructor(handlers = {}, options = {}) {
    this.h = handlers
    this.opts = { wake: true, threshold: null, followupS: 15, beeps: true, ...options }
    this.phase = null
    this.timer = null
    this.retryTimer = null
    this.attempt = 0
    this.stopped = false
    this.connectedOnce = false
    this.muted = false
    this.userSpeaking = false
    this.lastState = 'idle'
    this.connectArgs = null
    this.listener = null
    this.session = new VoiceSession(this._sessionHandlers(), { audioElement: options.audioElement || null })
  }

  // ── public (same shape as VoiceSession, for VoiceMode) ──────────

  async connect({ lang = 'auto', duplex = 'full' } = {}) {
    this.stopped = false
    // Wake-word barge-in needs full duplex: "hey Nandi" + your words interrupt her.
    this.connectArgs = { lang, duplex: this.opts.wake ? 'full' : duplex, wake: this.opts.wake ? 'device' : null }
    if (this.opts.wake) {
      this.session.serverMic = false      // nothing reaches the server before "hey Nandi"
      this._loadListener()
    }
    await this.session.connect(this.connectArgs)
  }

  dispose() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.listener?.dispose()
    this.listener = null
    this.session.dispose()
  }

  setMuted(muted) {
    this.muted = !!muted
    this.session.setMuted(this.muted)
    if (this.opts.wake && this.session.connected) {
      this._enter(PHASE.SLEEPING, { beep: false })
      if (this.muted) this.listener?.pause()     // deaf to the wake word too until unmuted
    }
    return this.muted
  }

  sendText(text) { return this.session.sendText(text) }

  resumeAudio() { this.session.resumeAudio() }

  /** Wake up as if "hey Nandi" was heard (a tap on the orb, the Wake button). */
  wake() {
    if (!this.opts.wake || !this.session.connected || this.muted) return
    this._onWake(null)
  }

  get wakeEnabled() { return !!this.opts.wake }

  // ── session events ─────────────────────────────────────────────

  _sessionHandlers() {
    const h = this.h
    return {
      onUserText: (t) => h.onUserText?.(t),
      onBotText: (t) => h.onBotText?.(t),
      onProgress: (t) => h.onProgress?.(t),
      onEngines: (e) => h.onEngines?.(e),
      onNotice: (t) => h.onNotice?.(t),
      onLevels: (l) => h.onLevels?.(l),
      onTurn: (t) => h.onTurn?.(t),
      onAudioBlocked: (b) => h.onAudioBlocked?.(b),
      onState: (state) => this._onState(state),
      onError: (err) => this._onError(err),
      onUserSpeaking: (speaking) => this._onUserSpeaking(speaking),
    }
  }

  _onState(state) {
    const prev = this.lastState
    this.lastState = state
    if (state === 'error') return               // _onError decides what the UI sees
    this.h.onState?.(state)
    if (!['listening', 'thinking', 'speaking'].includes(state)) return

    if (prev === 'connecting' || prev === 'idle' || prev === 'error') this._connected()
    if (!this.opts.wake) return

    if (state === 'thinking' || state === 'speaking') {
      if (this.phase === PHASE.LISTEN) {
        // Woken during a reply: she keeps talking until your words interrupt
        // her; a new turn ('thinking') means your request went through.
        if (state === 'thinking') this._enter(PHASE.REPLYING)
      } else if (this.phase !== PHASE.REPLYING) {
        // A turn went to the brain (said or typed), or she speaks unprompted.
        this._enter(PHASE.REPLYING)
      }
    } else if (prev === 'thinking' || prev === 'speaking') {
      // Back to 'listening': the reply is over, or the user cut it short.
      this.session.duck(false)
      if (this.phase === PHASE.REPLYING) this._enter(PHASE.FOLLOWUP)
    }
  }

  _connected() {
    clearTimeout(this.retryTimer)
    this.attempt = 0
    if (this.opts.beeps) playBeep(this.connectedOnce ? 'connected' : 'ready')
    this.connectedOnce = true
    if (!this.opts.wake) {
      this._setPhase(PHASE.OPEN)
      return
    }
    this._attachListener()
    this._enter(PHASE.SLEEPING, { beep: false })
  }

  _onError(err) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.listener?.detach()
    if (FATAL.has(err?.code) || !this.connectedOnce) {
      // Can't fix itself (or never connected at all): show it, with "Try again".
      this.h.onState?.('error')
      this.h.onError?.(err)
      if (this.opts.beeps && this.connectedOnce) playBeep('error')
      return
    }
    // Dropped, server restarted, idle timeout: stay in voice mode and come back.
    const inS = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)]
    this.attempt++
    this.h.onState?.('connecting')
    this.h.onReconnect?.({ inS, attempt: this.attempt })
    this.retryTimer = setTimeout(() => {
      if (this.stopped) return
      if (this.opts.wake) this.session.serverMic = false     // back asleep until "hey Nandi"
      this.session.connect(this.connectArgs)
    }, inS * 1000)
  }

  _onUserSpeaking(speaking) {
    this.userSpeaking = !!speaking
    if (!this.opts.wake) return
    // The server sent the sentence to the brain while you were still talking:
    // the mic stayed open for the rest (see REPLYING); close it now.
    if (!speaking && this.phase === PHASE.REPLYING) this.session.setServerMic(false)
    if (speaking) {
      if (this.phase === PHASE.LISTEN || this.phase === PHASE.FOLLOWUP) this._enter(PHASE.HEARING)
      else if (this.phase === PHASE.HEARING) clearTimeout(this.timer)
    } else if (this.phase === PHASE.HEARING) {
      // The turn normally starts now (thinking); if it doesn't, don't hang.
      this._later(NOTHING_HEARD_S, () => {
        if (this.phase === PHASE.HEARING) this._enter(PHASE.FOLLOWUP)
      })
    }
  }

  // ── wake word ──────────────────────────────────────────────────

  _loadListener() {
    if (this.listener) return
    this.listener = new WakeListener({
      onWake: (score) => this._onWake(score),
      onScore: (score) => this.h.onWakeScore?.(score),
    }, { threshold: this.opts.threshold })
    this.listener.init()
      .then(() => this.h.onWakeReady?.(true))
      .catch((err) => {
        console.warn('[wake] the wake word could not start:', err)
        this.h.onWakeReady?.(false, err)
      })
  }

  async _attachListener() {
    const track = this.session.localMicTrack()
    if (!this.listener || !track) return
    try {
      await this.listener.attach(track)
      if (this.muted || (this.phase !== PHASE.SLEEPING && this.phase !== PHASE.REPLYING)) this.listener.pause()
    } catch (err) {
      console.warn('[wake] cannot listen to the mic:', err)
      this.h.onWakeReady?.(false, err)
    }
  }

  _onWake(score) {
    if (this.stopped || this.muted || !this.session.connected) return
    if (this.phase !== PHASE.SLEEPING && this.phase !== PHASE.REPLYING && score !== null) return
    if (score !== null) console.info(`[wake] "hey Nandi" (score ${score.toFixed(3)})`)
    if (this.phase === PHASE.REPLYING && (this.session.botSpeaking || this.lastState === 'speaking')) {
      this.session.duck(true)      // she is talking: make room for what comes next
    }
    this._enter(PHASE.LISTEN)
  }

  // ── phases ─────────────────────────────────────────────────────

  _enter(phase, { beep = true } = {}) {
    const from = this.phase
    clearTimeout(this.timer)
    const s = this.session
    switch (phase) {
      case PHASE.SLEEPING:
        s.setServerMic(false)
        s.duck(false)
        this.listener?.resume()
        if (beep && this.opts.beeps && from && from !== PHASE.SLEEPING) playBeep('sleep')
        this._setPhase(phase)
        break
      case PHASE.LISTEN:
        this.listener?.pause()
        if (beep && this.opts.beeps) playBeep('wake')
        s.setServerMic(true)
        this._setPhase(phase, LISTEN_S)
        this._later(LISTEN_S, () => {
          if (this.phase !== PHASE.LISTEN) return
          // Nothing said. Back to the reply if she is still talking, else to sleep.
          if (s.botSpeaking || this.lastState === 'speaking' || this.lastState === 'thinking') {
            s.duck(false)
            this._enter(PHASE.REPLYING)
          } else {
            this._enter(PHASE.SLEEPING)
          }
        })
        break
      case PHASE.HEARING:
        this.listener?.pause()
        s.setServerMic(true)
        this._setPhase(phase)
        break
      case PHASE.REPLYING:
        // Close the mic so room talk can't interrupt her - unless the user is
        // still mid-sentence (the server cut the turn early): then it closes
        // when they stop, and the rest isn't lost.
        s.setServerMic(from === PHASE.HEARING && this.userSpeaking)
        this.listener?.resume()
        this._setPhase(phase)
        this._later(REPLY_TIMEOUT_S, () => { if (this.phase === PHASE.REPLYING) this._enter(PHASE.FOLLOWUP) })
        break
      case PHASE.FOLLOWUP: {
        s.duck(false)
        const secs = Number(this.opts.followupS) || 0
        if (secs <= 0) {
          this._enter(PHASE.SLEEPING)
          break
        }
        this.listener?.pause()
        s.setServerMic(true)
        this._setPhase(phase, secs)
        this._later(secs, () => { if (this.phase === PHASE.FOLLOWUP) this._enter(PHASE.SLEEPING) })
        break
      }
      default:
    }
  }

  _setPhase(phase, seconds = 0) {
    this.phase = phase
    this.h.onPhase?.(phase, { until: seconds ? Date.now() + seconds * 1000 : 0 })
  }

  _later(seconds, fn) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (!this.stopped) fn() }, seconds * 1000)
  }
}
