import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import Attachment from './Attachment.jsx'
import MicWave from './MicWave.jsx'
import { IconPaperclip, IconMic, IconSend, IconVoice } from './Icons.jsx'
import { startRecording, stopRecording, cancelRecording } from '../lib/audioRecorder.js'
import { stop as stopTts, getIsPlaying } from '../lib/ttsPlayer.js'

// The recorder's RMS runs small (speech is ~0.02–0.2); this maps it to 0..1.
const MIC_GAIN = 5

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/**
 * The compact, voice-first bar: a big mic button first, then a short text box,
 * attach, and Send only once there is something to send.
 *
 * The mic is press to start, press again to stop and transcribe — it no longer
 * stops by itself on a pause. While it records, the text box gives way to a
 * dotted wave of your voice, the time, and ✕ to throw the recording away.
 *
 * Typing or starting the mic while Nandi is speaking cuts the voice off.
 *
 * onMicPhase(phase)         'idle' | 'recording' | 'transcribing'
 * onVoiceMode()             opens voice mode (a live spoken conversation); the
 *                           mic button is one-shot dictation into this bar
 * ref: focus(), toggleMic(), startMic(), stopMic(), cancelMic()
 */
const ChatInput = forwardRef(function ChatInput({
  onSend,
  onMicPhase,
  onVoiceMode,
}, ref) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)
  // idle → recording → transcribing → idle. phaseRef is the same value without
  // waiting for a render: hold-Space can press and release within one frame.
  const [phase, setPhaseState] = useState('idle')
  const phaseRef = useRef('idle')
  const [elapsed, setElapsed] = useState(0)
  // Mic and STT failures were console-only: the button just stopped pulsing
  // and nothing was transcribed, with no hint as to why.
  const [micError, setMicError] = useState('')
  const attachRef = useRef(null)
  const textareaRef = useRef(null)
  const micBtnRef = useRef(null)
  const levelRef = useRef(0)
  // The attachments at the moment the transcript comes back, not when the
  // recording started.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const recording = phase === 'recording'

  const setPhase = useCallback((next) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  useEffect(() => { onMicPhase?.(phase) }, [phase, onMicPhase])

  // The recording's clock (only this bar re-renders for it).
  useEffect(() => {
    if (!recording) return undefined
    const started = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500)
    return () => clearInterval(id)
  }, [recording])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [text])

  const handleAttachChange = useCallback((ready, isUploading) => {
    setAttachments(ready)
    setUploading(isUploading)
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (uploading) return

    onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    attachRef.current?.clear()

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [text, attachments, uploading, onSend])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Mic (STT) ───────────────────────────────────────────
  const startMic = async () => {
    if (phaseRef.current !== 'idle') return
    if (getIsPlaying()) stopTts()
    setMicError('')
    levelRef.current = 0
    setPhase('recording')
    try {
      const transcribed = await startRecording(
        (rms) => { levelRef.current = Math.min(1, rms * MIC_GAIN) },
        { onStop: () => setPhase('transcribing') },
      )
      if (transcribed) {
        // Check auto-send setting
        const autoSend = localStorage.getItem('nandi_auto_send_stt') !== 'false'
        if (autoSend) {
          onSend(transcribed, attachmentsRef.current)
          attachRef.current?.clear()
        } else {
          setText(prev => prev ? `${prev} ${transcribed}` : transcribed)
        }
      }
    } catch (err) {
      console.error('[mic] error:', err)
      const denied =
        err?.name === 'NotAllowedError' || /permission/i.test(err?.message || '')
      const noDevice = err?.name === 'NotFoundError'

      // transcribe() says in words what failed (session expired, speech
      // service down, server unreachable); anything else gets the raw reason.
      setMicError(
        denied
          ? 'Microphone blocked. Allow mic access for this site, then try again.'
          : noDevice
            ? 'No microphone found.'
            : err?.userMessage || `Could not transcribe: ${err?.message || 'unknown error'}`
      )
    } finally {
      levelRef.current = 0
      setPhase('idle')
    }
  }

  // Stop and transcribe. The recorder copes with a stop that arrives while
  // the microphone is still opening (a quick tap of Space).
  const stopMic = () => { if (phaseRef.current === 'recording') stopRecording() }
  const cancelMic = () => { if (phaseRef.current === 'recording') cancelRecording() }
  const toggleMic = () => {
    if (phaseRef.current === 'idle') startMic()
    else if (phaseRef.current === 'recording') stopMic()
  }

  // Read by the parent (core click, hold Space, Esc) through the ref. A ref
  // keeps the latest handlers, which close over the current state.
  const micRef = useRef(null)
  micRef.current = { startMic, stopMic, cancelMic, toggleMic }
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    toggleMic: () => micRef.current.toggleMic(),
    startMic: () => micRef.current.startMic(),
    stopMic: () => micRef.current.stopMic(),
    cancelMic: () => micRef.current.cancelMic(),
  }), [])

  const handleChange = (e) => {
    // Typing while Nandi talks means you want to cut in.
    if (getIsPlaying()) stopTts()
    setText(e.target.value)
  }

  const hasContent = text.trim().length > 0 || attachments.length > 0
  const showSend = hasContent && phase === 'idle'
  const transcribing = phase === 'transcribing'

  return (
    <>
      <Attachment ref={attachRef} onChange={handleAttachChange} />

      {micError && (
        <div className="chat-input-error" role="alert">
          {micError}
          <button
            className="chat-input-error__dismiss"
            onClick={() => setMicError('')}
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}

      <div className={`chat-input-bar${recording ? ' chat-input-bar--listening' : ''}${transcribing ? ' chat-input-bar--busy' : ''}`}>
        <button
          ref={micBtnRef}
          className={`chat-input-bar__mic${recording ? ' chat-input-bar__mic--on' : ''}`}
          title={recording ? 'Stop and send' : transcribing ? 'Transcribing…' : 'Talk (or hold Space)'}
          aria-label={recording ? 'Stop recording' : 'Talk'}
          aria-pressed={recording}
          onClick={toggleMic}
          disabled={transcribing}
        >
          <IconMic />
        </button>

        {/* Hidden, not unmounted, while the mic is on: what was typed stays. */}
        <textarea
          ref={textareaRef}
          className="chat-input-bar__textarea"
          placeholder="Talk, or type to Nandi"
          aria-label="Message Nandi"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          hidden={phase !== 'idle'}
        />
        {recording && (
          <div className="chat-input-bar__rec" role="status" aria-label="Recording — press the mic again to send">
            <MicWave levelRef={levelRef} active pulseRef={micBtnRef} className="chat-input-bar__wave" />
            <span className="chat-input-bar__time">{clock(elapsed)}</span>
            <button className="chat-input-bar__icon-btn" title="Cancel (Esc)" aria-label="Cancel recording" onClick={cancelMic}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        )}
        {transcribing && <div className="chat-input-bar__rec chat-input-bar__rec--busy" role="status">Transcribing…</div>}

        {/* Voice mode: a live, spoken conversation. Not while dictating: the
            two would fight over the microphone. */}
        {onVoiceMode && (
          <button
            className="chat-input-bar__icon-btn"
            title="Voice mode — talk with Nandi"
            aria-label="Voice mode"
            onClick={onVoiceMode}
            disabled={phase !== 'idle'}
          >
            <IconVoice size={16} />
          </button>
        )}

        <button
          className="chat-input-bar__icon-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => attachRef.current?.triggerSelect()}
        >
          <IconPaperclip size={16} />
        </button>

        {showSend && (
          <button
            className="chat-input-bar__icon-btn chat-input-bar__icon-btn--send"
            title="Send"
            aria-label="Send"
            onClick={handleSend}
            disabled={uploading}
          >
            <IconSend size={16} />
          </button>
        )}
      </div>
    </>
  )
})

export default ChatInput