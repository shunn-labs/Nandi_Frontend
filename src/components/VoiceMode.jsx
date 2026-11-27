import React, { useCallback, useEffect, useRef, useState } from 'react'
import { WakeVoice, PHASE } from '../lib/wakeVoice.js'
import {
  VOICE_WAKE_EVENT, getBeepsEnabled, getFollowupSeconds, getVoiceDuplex, getVoiceLang, getWakeEnabled, getWakeThreshold,
} from '../lib/voicePrefs.js'
import { forgottenPermissionHint } from '../lib/mediaPermission.js'
import { IconMic, IconMicOff, IconSend } from './Icons.jsx'
import MicWave from './MicWave.jsx'

const STATE_LABEL = {
  idle: 'Voice off',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  error: 'Voice stopped',
}

const CONNECTED = new Set(['listening', 'thinking', 'speaking'])

// With the wake word on, what the panel says follows the Pi-style phase.
const PHASE_LABEL = {
  [PHASE.SLEEPING]: 'Say “Hey Nandi”',
  [PHASE.LISTEN]: 'Listening',
  [PHASE.HEARING]: 'Hearing you',
  [PHASE.FOLLOWUP]: 'Go on…',
}

// The mic level comes from the transport (already 0..1); Nandi's is a raw RMS,
// which runs much smaller. Nandi's level moves the core; the user's only the
// dotted wave in this panel — the core stays calm while you talk.
const MIC_GAIN = 3
const BOT_GAIN = 4

const ENGINE_DETAIL = { local: 'Nandi’s own GPU', elevenlabs: 'ElevenLabs (cloud)' }
const NOTICE_MS = 8000

/** Who is speaking right now: "GPU · Aiden" or "ElevenLabs", with the details in a tooltip. */
function engineBadge(engines) {
  if (!engines || (!engines.stt && !engines.tts)) return null
  const voice = engines.tts === 'elevenlabs' ? 'ElevenLabs'
    : engines.tts === 'local' ? `GPU · ${engines.voice || 'local'}`
    : engines.tts || '?'
  const cloudStt = engines.stt === 'elevenlabs' && engines.tts !== 'elevenlabs'
  const sttDetail = ENGINE_DETAIL[engines.stt] || engines.stt || '?'
  const ttsDetail = ENGINE_DETAIL[engines.tts] || engines.tts || '?'
  return {
    text: cloudStt ? `${voice} · cloud STT` : voice,
    cloud: engines.stt === 'elevenlabs' || engines.tts === 'elevenlabs',
    title: `Speech recognition: ${sttDetail} · Voice: ${ttsDetail}`
      + (engines.voice && engines.tts === 'local' ? ` (speaker ${engines.voice})` : ''),
  }
}

function hintFor(state, muted, phase, wakeReady, secondsLeft) {
  if (state === 'connecting') return 'Connecting to Nandi…'
  if (muted && CONNECTED.has(state)) return 'Your microphone is muted.'
  if (phase === PHASE.SLEEPING) {
    return wakeReady === false
      ? 'The wake word could not start here — tap Wake (or the globe) to talk.'
      : 'Say “Hey Nandi” or “Hi Nandi” — or tap Wake. Ctrl+H ends voice mode.'
  }
  if (phase === PHASE.LISTEN) return 'Go ahead — Nandi is listening.'
  if (phase === PHASE.HEARING) return ''
  if (phase === PHASE.FOLLOWUP) return `Keep talking, no need to say “Hey Nandi”${secondsLeft ? ` (${secondsLeft}s)` : ''}.`
  if (state === 'listening') return muted ? 'Your microphone is muted.' : 'Go ahead — Nandi is listening.'
  if (state === 'thinking') return 'Nandi is thinking…'
  return ''
}

/**
 * VoiceMode — a real-time spoken conversation with Nandi (docked where the
 * input bar is while it is open).
 *
 * The audio server does the listening, the brain and the talking; this panel
 * shows the state and what Nandi is doing, and offers mute, typing during the
 * conversation, and End. What was heard and what Nandi is saying go to the
 * screen's captions through onCaption; without it the panel shows them itself.
 *
 * Props:
 *   onTurn({user, reply, status, typed})  a finished exchange, for the transcript (`reply` is
 *                                         the shown answer; only its short line was spoken)
 *                                         (the browser's chat socket never sees voice turns)
 *   onLevel(amplitude)                    Nandi's voice level, many times a second (0..1), for the core
 *   onState(state)                        connecting | listening | thinking | speaking | error
 *   onCaption({user, bot})                what was heard / what Nandi is saying, as it changes
 *   onClose()                             End was pressed
 */
export default function VoiceMode({ onTurn, onLevel, onState, onCaption, onClose }) {
  const [state, setState] = useState('connecting')
  const [error, setError] = useState('')
  const [userText, setUserText] = useState('')
  const [botText, setBotText] = useState('')
  const [progress, setProgress] = useState('')
  const [engines, setEngines] = useState(null)
  const [notice, setNotice] = useState('')
  const [muted, setMuted] = useState(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState(null)
  const [phaseUntil, setPhaseUntil] = useState(0)
  const [wakeReady, setWakeReady] = useState(null)
  const [, setTick] = useState(0)

  const sessionRef = useRef(null)
  const audioRef = useRef(null)
  const micLevelRef = useRef(0)
  const wakeScoreRef = useRef(0)
  // The session's callbacks are wired once; read the parent's current ones.
  const handlersRef = useRef({ onTurn, onLevel, onState, onCaption })
  handlersRef.current = { onTurn, onLevel, onState, onCaption }

  useEffect(() => { handlersRef.current.onState?.(state) }, [state])
  useEffect(() => { handlersRef.current.onCaption?.({ user: userText, bot: botText }) }, [userText, botText])
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const handleLevels = useCallback(({ mic, bot }) => {
    micLevelRef.current = Math.min(1, (mic || 0) * MIC_GAIN)
    handlersRef.current.onLevel?.(Math.min(1, (bot || 0) * BOT_GAIN))
  }, [])

  const start = useCallback(() => {
    sessionRef.current?.dispose()
    setState('connecting')
    setError('')
    setUserText('')
    setBotText('')
    setProgress('')
    setEngines(null)
    setNotice('')
    setMuted(false)
    setAudioBlocked(false)
    setPhase(null)
    setPhaseUntil(0)
    setWakeReady(null)

    // The browser is about to ask for the mic again although it was allowed
    // before (a one-time "allow", cleared data): say how to make it stick.
    forgottenPermissionHint('microphone').then((tip) => { if (tip) setNotice(tip) })

    const session = new WakeVoice({
      onState: setState,
      onUserText: setUserText,
      onBotText: setBotText,
      onProgress: setProgress,
      onEngines: setEngines,
      onNotice: setNotice,
      onLevels: handleLevels,
      onTurn: (turn) => handlersRef.current.onTurn?.(turn),
      onError: (err) => setError(err?.message || 'Voice mode stopped.'),
      onAudioBlocked: setAudioBlocked,
      onPhase: (p, { until }) => { setPhase(p); setPhaseUntil(until || 0) },
      onWakeReady: (ok) => setWakeReady(ok),
      onWakeScore: (score) => { wakeScoreRef.current = score },
      onReconnect: ({ inS }) => setNotice(`Connection lost — reconnecting in ${inS} s…`),
    }, {
      audioElement: audioRef.current,
      wake: getWakeEnabled(),
      threshold: getWakeThreshold(),
      followupS: getFollowupSeconds(),
      beeps: getBeepsEnabled(),
    })
    sessionRef.current = session
    session.connect({ lang: getVoiceLang(), duplex: getVoiceDuplex() })
  }, [handleLevels])

  useEffect(() => {
    // One tick late on purpose: StrictMode mounts, unmounts and mounts again
    // in development, and two sessions racing for the microphone and for the
    // voice server's few session slots is the last thing wanted. The first
    // mount's timer is cleared before it fires.
    const timer = setTimeout(start, 0)
    return () => {
      clearTimeout(timer)
      sessionRef.current?.dispose()      // the exchange in progress still reaches onTurn
      sessionRef.current = null
      handlersRef.current.onLevel?.(0)
      handlersRef.current.onState?.('idle')
    }
  }, [start])

  const connected = CONNECTED.has(state)

  // The globe (or anything) can wake voice mode, like saying "hey Nandi".
  useEffect(() => {
    const onWake = () => sessionRef.current?.wake()
    window.addEventListener(VOICE_WAKE_EVENT, onWake)
    return () => window.removeEventListener(VOICE_WAKE_EVENT, onWake)
  }, [])

  // A once-a-second tick while a timed phase (follow-up) counts down.
  useEffect(() => {
    if (!phaseUntil) return undefined
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [phaseUntil])
  const secondsLeft = phaseUntil ? Math.max(0, Math.ceil((phaseUntil - Date.now()) / 1000)) : 0
  const wakeMode = !!sessionRef.current?.wakeEnabled
  const canWake = wakeMode && connected && !muted && (phase === PHASE.SLEEPING || phase === PHASE.REPLYING)

  const toggleMute = () => {
    const next = !muted
    sessionRef.current?.setMuted(next)
    setMuted(next)
  }

  const handleSend = (e) => {
    e.preventDefault()
    if (sessionRef.current?.sendText(draft)) setDraft('')
  }

  const badge = engineBadge(engines)
  const label = connected && muted ? 'Muted'
    : connected && wakeMode && PHASE_LABEL[phase] ? PHASE_LABEL[phase]
    : STATE_LABEL[state] || state
  const hint = hintFor(state, muted, wakeMode ? phase : null, wakeReady, secondsLeft)
  const stateTitle = wakeMode && connected
    ? `Wake word ${wakeReady === false ? 'unavailable' : 'on'} · last score ${wakeScoreRef.current.toFixed(2)}`
    : undefined

  return (
    <section
      className={`voice-mode voice-mode--${state}${wakeMode && phase ? ` voice-mode--phase-${phase}` : ''}`}
      aria-label="Voice conversation with Nandi"
    >
      <div className="voice-mode__head">
        <span className="voice-mode__state" role="status" aria-live="polite" title={stateTitle}>
          <span className="voice-mode__dot" aria-hidden="true" />
          {label}
        </span>
        {/* Your voice, as a sliding dotted line (the core is Nandi's). */}
        <MicWave levelRef={micLevelRef} active={connected && !muted && (!wakeMode || [PHASE.LISTEN, PHASE.HEARING, PHASE.FOLLOWUP].includes(phase))}
          className="voice-mode__wave" />
        {badge && (
          <span
            className={`voice-mode__engine${badge.cloud ? ' voice-mode__engine--cloud' : ''}`}
            title={badge.title}
          >
            {badge.text}
          </span>
        )}
        <button className="voice-mode__end" onClick={onClose} title="End voice mode (Ctrl+H)">
          End
        </button>
      </div>

      <div className="voice-mode__body">
        {error ? (
          <div className="voice-mode__error" role="alert">
            <span>{error}</span>
            <button className="voice-mode__retry" onClick={start}>Try again</button>
          </div>
        ) : (
          <>
            {!onCaption && userText && (
              <p className="voice-mode__line voice-mode__line--user">
                <span className="voice-mode__who">You</span>
                {userText}
              </p>
            )}
            {!onCaption && botText && (
              <p className="voice-mode__line voice-mode__line--bot">
                <span className="voice-mode__who">Nandi</span>
                {botText}
              </p>
            )}
            {state === 'thinking' && progress && (
              <p className="voice-mode__progress">{progress}</p>
            )}
            {notice && (
              <p className="voice-mode__notice" role="status">{notice}</p>
            )}
            {(onCaption || (!userText && !botText)) && !(state === 'thinking' && progress) && hint && (
              <p className="voice-mode__hint">{hint}</p>
            )}
          </>
        )}
        {audioBlocked && (
          <button
            className="voice-mode__unblock"
            onClick={() => sessionRef.current?.resumeAudio()}
          >
            🔈 Tap to hear Nandi
          </button>
        )}
      </div>

      <form className="voice-mode__controls" onSubmit={handleSend}>
        <button
          type="button"
          className={`voice-mode__mute${muted ? ' voice-mode__mute--on' : ''}`}
          onClick={toggleMute}
          disabled={!connected}
          aria-pressed={muted}
          title={muted ? 'Unmute your microphone' : 'Mute your microphone'}
        >
          {muted ? <IconMicOff /> : <IconMic />}
        </button>
        {wakeMode && (
          <button
            type="button"
            className="voice-mode__wake"
            onClick={() => sessionRef.current?.wake()}
            disabled={!canWake}
            title="Talk now, as if you said “Hey Nandi”"
          >
            Wake
          </button>
        )}
        <input
          className="voice-mode__input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={connected ? 'Type to Nandi — she answers out loud' : 'Waiting for the voice connection…'}
          disabled={!connected}
          aria-label="Type a message during the voice conversation"
        />
        <button
          type="submit"
          className="voice-mode__send"
          disabled={!connected || !draft.trim()}
          title="Send"
          aria-label="Send"
        >
          <IconSend />
        </button>
      </form>

      {/* Nandi's voice. Hidden: the core and the state label are the UI. */}
      <audio ref={audioRef} autoPlay playsInline hidden />
    </section>
  )
}
