import React, { useState, useEffect, useRef, useCallback } from 'react'
import LogPanel from './LogPanel.jsx'
import Orb from './Orb.jsx'
import ChatInput from './ChatInput.jsx'
import VisionManager from './VisionManager.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import { IconSettings, IconLogs } from './Icons.jsx'
import {
  ensureConnection,
  onAuthFailure,
  onConnectionChange,
  onMessage,
  sendMessage,
} from '../lib/wsAdapter.js'
import { speak, stop as stopTts } from '../lib/ttsPlayer.js'

// How close to the bottom counts as "following the conversation". Below this
// distance a new message scrolls into view; above it the user is reading
// history and must be left alone.
const FOLLOW_THRESHOLD_PX = 120

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

// ── Live clock hook ───────────────────────────────────────
function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })

  const date = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return { time, date }
}

export default function ChatView({ deviceId, onLogout }) {
  const [messages, setMessages] = useState([])
  const [connected, setConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [visionOpen, setVisionOpen] = useState(false)
  const [orbAmplitude, setOrbAmplitude] = useState(0)
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    return localStorage.getItem('nandi_tts_enabled') !== 'false'
  })

  const messagesAreaRef = useRef(null)
  const chatInputRef = useRef(null)
  const visionMgrRef = useRef(null)
  const dragCountRef = useRef(0)
  const [isDragging, setIsDragging] = useState(false)

  const { time, date } = useClock()

  // ── WebSocket setup ────────────────────────────────────
  useEffect(() => {
    onConnectionChange((val) => setConnected(val))

    // An expired or invalid token used to produce an endless reconnect loop,
    // with the UI stuck on "Offline" and no explanation. Send the user back to
    // login instead.
    onAuthFailure(() => {
      localStorage.removeItem('user_token')
      onLogout()
    })

    onMessage((data) => {
      const text = data.response_text

      // An error frame has no response text. The placeholder used to stay on
      // screen as a permanent "Thinking…" because only a successful reply
      // replaced it.
      if (!text) {
        if (data.error) {
          setMessages(prev => {
            const last = prev[prev.length - 1]
            const errMsg = { role: 'ai', text: data.error, ts: Date.now(), isError: true }
            return (last && last.role === 'ai' && last.thinking)
              ? [...prev.slice(0, -1), errMsg]
              : [...prev, errMsg]
          })
        }
        return
      }

      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'ai' && last.thinking) {
          return [...prev.slice(0, -1), { role: 'ai', text, ts: Date.now() }]
        }
        return [...prev, { role: 'ai', text, ts: Date.now() }]
      })

      if (localStorage.getItem('nandi_tts_enabled') !== 'false') {
        speak(
          text,
          (vol) => setOrbAmplitude(vol * 4),
          () => setOrbAmplitude(0)
        )
      }
    })

    ensureConnection()
  }, [onLogout])

  // ── Keyboard shortcuts ──────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        chatInputRef.current?.focus()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        setMessages([])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Auto-scroll ────────────────────────────────────────
  // Scrolls the container directly rather than calling scrollIntoView on a
  // sentinel div. scrollIntoView walks up to whichever ancestor it decides is
  // scrollable and, with `behavior: 'smooth'`, its animation is cancelled by the
  // next React render — which for a streaming-ish chat is almost immediately.
  // The net effect was that the view never moved and replies stayed below the
  // fold.
  //
  // It also respects where the user is: if they have scrolled up to read
  // history, new messages must not yank them back down.
  //
  // Whether the user has deliberately scrolled up is tracked by a
  // real scroll event, NOT inferred from geometry at render time: a container
  // measured while it has no usable height (first paint, hidden tab, a panel
  // mid-transition) reports a huge distance-from-bottom, which reads as "the
  // user scrolled away" and stops the chat following forever — with no way back
  // except scrolling to the bottom by hand.
  const userScrolledUpRef = useRef(false)

  useEffect(() => {
    const area = messagesAreaRef.current
    if (!area) return

    const onScroll = () => {
      const distance = area.scrollHeight - area.clientHeight - area.scrollTop
      userScrolledUpRef.current = distance > FOLLOW_THRESHOLD_PX
    }
    area.addEventListener('scroll', onScroll, { passive: true })
    return () => area.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const area = messagesAreaRef.current
    if (!area || userScrolledUpRef.current) return

    // rAF so the new message is laid out before we scroll to it.
    const id = requestAnimationFrame(() => {
      area.scrollTo({
        top: area.scrollHeight,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
    })
    return () => cancelAnimationFrame(id)
  }, [messages])

  // ── Send handler ───────────────────────────────────────
  const handleSend = useCallback((text, attachments) => {
    if (!text && attachments.length === 0) return

    // Sending is an explicit signal the user wants to see what comes back.
    userScrolledUpRef.current = false

    setMessages(prev => [
      ...prev,
      {
        role: 'user',
        text: text || '(file attachment)',
        ts: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      { role: 'ai', text: '', thinking: true, ts: Date.now() },
    ])

    sendMessage(text, attachments)
  }, [])

  // ── Vision capture → attach to chat (mimics file upload flow) ──
  const handleVisionCapture = useCallback((file, label) => {
    // Reuse the existing global drop-files event that Attachment listens for.
    // This pushes the captured frame through the normal upload pipeline,
    // so it appears as an attachment chip above the input bar exactly like
    // a dragged file would.
    window.dispatchEvent(new CustomEvent('nandi-drop-files', {
      detail: [file],
    }))
    // Focus chat so user can immediately type a question about it
    setTimeout(() => chatInputRef.current?.focus(), 50)
  }, [])

  // ── Mic volume → orb ──────────────────────────────────
  const handleMicVolume = useCallback((vol) => {
    setOrbAmplitude(vol * 5)
  }, [])

  // ── TTS toggle ─────────────────────────────────────────
  const handleTtsToggle = useCallback(() => {
    setTtsEnabled(prev => {
      const next = !prev
      localStorage.setItem('nandi_tts_enabled', next)
      if (!next) stopTts()
      return next
    })
  }, [])

  // ── Camera button → start/stop vision producer ─────────
  const handleCameraClick = useCallback(() => {
    const mgr = visionMgrRef.current
    if (!mgr) return
    if (mgr.isCameraOn()) {
      mgr.stopCameraProducer()
    } else {
      mgr.startCameraProducer()
    }
  }, [])

  // ── Global drag-and-drop ───────────────────────────────
  useEffect(() => {
    const onDragEnter = (e) => {
      e.preventDefault()
      dragCountRef.current++
      setIsDragging(true)
    }
    const onDragLeave = (e) => {
      e.preventDefault()
      if (--dragCountRef.current === 0) setIsDragging(false)
    }
    const onDragOver = (e) => e.preventDefault()
    const onDrop = (e) => {
      e.preventDefault()
      dragCountRef.current = 0
      setIsDragging(false)
      if (e.dataTransfer.files.length) {
        window.dispatchEvent(new CustomEvent('nandi-drop-files', {
          detail: e.dataTransfer.files,
        }))
      }
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)

    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="app-layout">
      {/* ─── Header ─── */}
      <header className="app-header">
        <div className="app-header__left">
          <img src="/logo.png" alt="Nandi AI" className="app-header__logo" />
          <span className="app-header__brand">NANDI AI</span>
          <span className="app-header__status">
            <span className={`app-header__dot${connected ? '' : ' app-header__dot--off'}`} />
            {connected ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="app-header__center">
          <span className="app-header__time">{time}</span>
          <span className="app-header__date">{date}</span>
        </div>

        <div className="app-header__right">
          <button
            className="app-header__toggle-logs"
            onClick={() => setLogsOpen(prev => !prev)}
          >
            <IconLogs size={15} />
            <span style={{ marginLeft: 4 }}>Logs</span>
          </button>
          <button
            className="app-header__toggle-logs"
            onClick={() => setVisionOpen(prev => !prev)}
          >
            <span>👁 Vision</span>
          </button>
          <button
            className="app-header__settings-btn"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings size={17} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* ─── Log Sidebar (left) ─── */}
      <aside className={`log-sidebar${logsOpen ? ' log-sidebar--open' : ''}`}>
        <LogPanel />
      </aside>

      {/* ─── Chat Area (center, ChatGPT-style width) ─── */}
      <main className="chat-area">
        <Orb amplitude={orbAmplitude} />

        <div className="messages-area" ref={messagesAreaRef}>
          <div className="messages-inner">
            {messages.length === 0 && (
              <div style={{
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '1rem',
                padding: '40px 20px',
                lineHeight: 1.7,
              }}>
                Hey! Type, talk, or drop files — Nandi is ready.
                <br />
                <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>
                  Ctrl+K to focus · Ctrl+L to clear
                </span>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`msg msg--${msg.role}`}>
                <span className="msg__label">
                  {msg.role === 'user' ? 'You' : 'Nandi'}
                </span>
                <div className="msg__bubble">
                  {msg.thinking ? (
                    <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Thinking…
                    </span>
                  ) : msg.isError ? (
                    <span style={{ color: '#ff8a8a' }}>{msg.text}</span>
                  ) : (
                    msg.text
                  )}
                </div>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="msg__attachments">
                    {msg.attachments.map((att, j) => (
                      <span key={j} className="msg__att-tag">
                        📎 {att.filename}
                      </span>
                    ))}
                  </div>
                )}
                <span className="msg__meta">
                  {new Date(msg.ts).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="chat-input-wrap">
          <div className="chat-input-inner">
            <ChatInput
              ref={chatInputRef}
              onSend={handleSend}
              onCameraOpen={handleCameraClick}
              onMicVolume={handleMicVolume}
              ttsActive={ttsEnabled}
              onTtsToggle={handleTtsToggle}
            />
          </div>
        </div>
      </main>

      {/* ─── Vision Column (right) ─── */}
      <aside className={`vision-column${visionOpen ? ' vision-column--open' : ''}`}>
        <VisionManager
          ref={visionMgrRef}
          onCaptureToChat={handleVisionCapture}
        />
      </aside>

      {/* ─── Settings ─── */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
        />
      )}

      {/* ─── Drop overlay ─── */}
      {isDragging && (
        <div className="drop-overlay">
          <span className="drop-overlay__label">📎 Drop files to attach</span>
        </div>
      )}
    </div>
  )
}
