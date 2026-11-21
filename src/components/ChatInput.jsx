import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import Attachment from './Attachment.jsx'
import { IconPaperclip, IconMic, IconSend, IconVoice } from './Icons.jsx'
import { startRecording, stopRecording, isRecording } from '../lib/audioRecorder.js'
import { stop as stopTts, getIsPlaying } from '../lib/ttsPlayer.js'

/**
 * The compact, voice-first bar: a big mic button first, then a short text box,
 * attach, and Send only once there is something to send.
 *
 * Typing or starting the mic while Nandi is speaking cuts the voice off.
 *
 * onMicVolume(level)        mic level while recording, for the core
 * onRecordingChange(bool)   so the core can show it is listening
 * onVoiceMode()             opens voice mode (a live spoken conversation); the
 *                           mic button is one-shot dictation into this bar
 * ref: focus(), toggleMic()
 */
const ChatInput = forwardRef(function ChatInput({
  onSend,
  onMicVolume,
  onRecordingChange,
  onVoiceMode,
}, ref) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  // Mic and STT failures were console-only: the button just stopped pulsing
  // and nothing was transcribed, with no hint as to why.
  const [micError, setMicError] = useState('')
  const attachRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => { onRecordingChange?.(recording) }, [recording, onRecordingChange])

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
  const handleMicClick = async () => {
    if (recording) {
      stopRecording()
      setRecording(false)
      return
    }

    if (getIsPlaying()) stopTts()
    setMicError('')
    setRecording(true)
    try {
      const transcribed = await startRecording((vol) => {
        if (onMicVolume) onMicVolume(vol)
      })
      setRecording(false)
      if (onMicVolume) onMicVolume(0)

      if (transcribed) {
        // Check auto-send setting
        const autoSend = localStorage.getItem('nandi_auto_send_stt') !== 'false'
        if (autoSend) {
          onSend(transcribed, attachments)
          attachRef.current?.clear()
        } else {
          setText(prev => prev ? `${prev} ${transcribed}` : transcribed)
        }
      }
    } catch (err) {
      console.error('[mic] error:', err)
      setRecording(false)
      if (onMicVolume) onMicVolume(0)

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
    }
  }

  // Read by the parent (core click, hold Space) through the ref. A ref keeps
  // the latest handleMicClick, which closes over the current attachments.
  const micRef = useRef(handleMicClick)
  micRef.current = handleMicClick
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    toggleMic: () => micRef.current(),
  }), [])

  const handleChange = (e) => {
    // Typing while Nandi talks means you want to cut in.
    if (getIsPlaying()) stopTts()
    setText(e.target.value)
  }

  const hasContent = text.trim().length > 0 || attachments.length > 0
  const showSend = hasContent && !recording

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

      <div className={`chat-input-bar${recording ? ' chat-input-bar--listening' : ''}`}>
        <button
          className={`chat-input-bar__mic${recording ? ' chat-input-bar__mic--on' : ''}`}
          title={recording ? 'Stop and send' : 'Talk (or hold Space)'}
          aria-label={recording ? 'Stop recording' : 'Talk'}
          aria-pressed={recording}
          onClick={handleMicClick}
        >
          <IconMic />
        </button>

        <textarea
          ref={textareaRef}
          className="chat-input-bar__textarea"
          placeholder={recording ? 'Listening…' : 'Talk, or type to Nandi'}
          aria-label="Message Nandi"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        {/* Voice mode: a live, spoken conversation. Not while dictating: the
            two would fight over the microphone. */}
        {onVoiceMode && (
          <button
            className="chat-input-bar__icon-btn"
            title="Voice mode — talk with Nandi"
            aria-label="Voice mode"
            onClick={onVoiceMode}
            disabled={recording}
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