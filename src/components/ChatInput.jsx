import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import Attachment from './Attachment.jsx'
import { IconPaperclip, IconCamera, IconMic, IconSpeaker, IconSend } from './Icons.jsx'
import { startRecording, stopRecording, isRecording } from '../lib/audioRecorder.js'
import { stop as stopTts, getIsPlaying } from '../lib/ttsPlayer.js'

const ChatInput = forwardRef(function ChatInput({
  onSend,
  onCameraOpen,
  onMicVolume,
  ttsActive,
  onTtsToggle,
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

  // Expose focus method for Ctrl+K
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

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

      setMicError(
        err?.code === 'STT_UNAVAILABLE'
          ? err.message
          : denied
          ? 'Microphone blocked. Allow mic access for this site, then try again.'
          : noDevice
            ? 'No microphone found.'
            : `Could not transcribe: ${err?.message || 'unknown error'}`
      )
    }
  }

  // ── Speaker (TTS toggle) ─────────────────────────────────
  const handleSpeakerClick = () => {
    if (getIsPlaying()) {
      stopTts()
    }
    onTtsToggle()
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !uploading

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

      <div className="chat-input-bar">
        {/* Attach */}
        <button
          className="chat-input-bar__attach-btn"
          title="Attach files"
          onClick={() => attachRef.current?.triggerSelect()}
        >
          <IconPaperclip />
        </button>

        {/* Text area */}
        <textarea
          ref={textareaRef}
          className="chat-input-bar__textarea"
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        {/* Camera */}
        <button
          className="chat-input-bar__action-btn"
          title="Open camera"
          onClick={onCameraOpen}
        >
          <IconCamera />
        </button>

        {/* Mic */}
        <button
          className={`chat-input-bar__action-btn${recording ? ' chat-input-bar__action-btn--recording' : ''}`}
          title={recording ? 'Stop recording' : 'Voice input'}
          onClick={handleMicClick}
        >
          <IconMic />
        </button>

        {/* Speaker */}
        <button
          className={`chat-input-bar__action-btn${ttsActive ? ' chat-input-bar__action-btn--active' : ''}`}
          title={ttsActive ? 'TTS enabled — click to disable' : 'Enable TTS'}
          onClick={handleSpeakerClick}
        >
          <IconSpeaker />
        </button>

        {/* Send */}
        <button
          className="chat-input-bar__action-btn chat-input-bar__action-btn--send"
          title="Send"
          onClick={handleSend}
          disabled={!canSend}
        >
          <IconSend />
        </button>
      </div>
    </>
  )
})

export default ChatInput