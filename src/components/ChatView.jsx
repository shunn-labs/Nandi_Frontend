import React, { useState, useEffect, useRef, useCallback } from 'react'
import LogPanel from './LogPanel.jsx'
import Orb from './Orb.jsx'
import ChatInput from './ChatInput.jsx'
import VisionManager from './VisionManager.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import Markdown from './Markdown.jsx'
import PromptCard from './PromptCard.jsx'
import ActivityCard, { applyActivity } from './ActivityCard.jsx'
import { IconSettings, IconLogs } from './Icons.jsx'
import {
  ensureConnection,
  onAuthFailure,
  onConnectionChange,
  onMessage,
  sendMessage,
} from '../lib/wsAdapter.js'
import { speak, stop as stopTts } from '../lib/ttsPlayer.js'
import { onPhoneFrame, onPhoneStatus, sendPhone } from '../lib/phoneChannel.js'

// How close to the bottom counts as "following the conversation". Below this
// distance a new message scrolls into view; above it the user is reading
// history and must be left alone.
const FOLLOW_THRESHOLD_PX = 120

// How long a "Thinking…" placeholder may go without hearing anything before it
// is called a failure. Every progress frame (the server sends a heartbeat at
// least every ~15 s) restarts it, so a long vision job that keeps reporting in
// is never cut off — only silence is.
// Without this, anything that stops a reply from arriving — a dropped socket, a
// server that never answers, a queued message on a connection that never comes
// back — left the placeholder spinning for the rest of the session.
const REPLY_TIMEOUT_MS = 90000

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

// Index of the placeholder still waiting on `requestId`, or -1.
const findPending = (list, requestId) =>
  list.findIndex(m => m.thinking && m.requestId === requestId)

// Server-supplied fields are coerced to strings before they reach JSX: an
// object there would throw during render and blank the whole chat.
const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

const toProblem = (e) => (e && typeof e === 'object'
  ? { stage: asText(e.stage), source: asText(e.source), message: asText(e.message), hint: asText(e.hint) }
  : { stage: '', source: '', message: asText(e), hint: '' })

// The structured errors attached to an answer — a camera that was offline, a
// tool that failed. Collapsed by default: the answer already says in words
// what went wrong, and this is the detail behind it.
function ProblemList({ errors }) {
  return (
    <details className="msg__problems">
      <summary>⚠ {errors.length} {errors.length === 1 ? 'problem' : 'problems'}</summary>
      <ul>
        {errors.map((err, i) => {
          const where = [err.stage, err.source].filter(Boolean).join(' · ')
          return (
            <li key={i}>
              {where && <span className="msg__problem-where">{where}</span>}
              {where && err.message && ' — '}
              {err.message}
              {err.hint && <span className="msg__problem-hint">Fix: {err.hint}</span>}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

// ── Phone cards (approvals, questions, live steps, events) ────────────────
// A card goes before a pending "Thinking…" placeholder, so the reply still
// replaces the placeholder and lands under the card.
function insertCard(list, card) {
  const last = list[list.length - 1]
  return (last && last.role === 'ai' && last.thinking)
    ? [...list.slice(0, -1), card, last]
    : [...list, card]
}

function promptMessage(f) {
  return {
    role: 'prompt', kind: f.kind === 'question' ? 'question' : 'approval', id: asText(f.id),
    device: asText(f.device), what: asText(f.what), why: asText(f.why),
    options: Array.isArray(f.options) ? f.options.map(asText) : [], allowText: !!f.allow_text,
    expiresAt: Number(f.expires_at) || Date.now() + 60000, status: 'open', ts: Date.now(),
  }
}

function eventText(f) {
  const d = (f.data && typeof f.data === 'object') ? f.data : {}
  const who = asText(d.caller || d.from || d.name || d.number || 'someone')
  switch (f.kind) {
    case 'call.incoming': return `📞 ${who} is calling`
    case 'call.missed': return `📞 Missed call from ${who}`
    case 'message': {
      const app = asText(d.app)
      const text = asText(d.text)
      return `💬 ${app ? app + ' · ' : ''}${who}${text ? ': ' + text : ''}`
    }
    case 'battery.low': return `🔋 Battery low${d.level != null ? ` (${asText(d.level)}%)` : ''}`
    default: return `📱 ${asText(f.kind)}`
  }
}

const deviceName = (d) => (d === 'tab' ? 'tablet' : (d || 'phone'))

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
  const [phone, setPhone] = useState({ connected: false, devices: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [visionOpen, setVisionOpen] = useState(false)
  const [orbAmplitude, setOrbAmplitude] = useState(0)
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    return localStorage.getItem('nandi_tts_enabled') !== 'false'
  })
  // Owned here rather than inside SettingsPanel, which is unmounted whenever
  // the panel is closed — state that has to outlive the panel cannot live in
  // it. This is what makes the "Show activity logs" toggle do something.
  const [showLogs, setShowLogs] = useState(() => {
    return localStorage.getItem('nandi_show_logs') !== 'false'
  })

  // onMessage is registered once, so it closes over the first render's
  // `ttsEnabled`. A ref keeps the callback reading today's value.
  const ttsEnabledRef = useRef(ttsEnabled)
  useEffect(() => { ttsEnabledRef.current = ttsEnabled }, [ttsEnabled])

  // One timeout per outstanding request: requestId → timeout id. A single
  // shared timer was cleared by ANY reply, so the answer to one message also
  // cancelled the timeout of every other message still waiting.
  //
  // An entry exists exactly while its "Thinking…" placeholder does, and the
  // map keeps send order, so its last key is the newest placeholder waiting.
  const replyTimersRef = useRef(new Map())

  const clearReplyTimer = useCallback((requestId) => {
    const timers = replyTimersRef.current
    clearTimeout(timers.get(requestId))
    timers.delete(requestId)
  }, [])

  const clearAllReplyTimers = useCallback(() => {
    const timers = replyTimersRef.current
    for (const id of timers.values()) clearTimeout(id)
    timers.clear()
  }, [])

  // Turns one request's placeholder into an error. A no-op if that placeholder
  // is already gone, so a reply that landed first is never overwritten.
  const failPending = useCallback((requestId, reason) => {
    setMessages(prev => {
      const i = findPending(prev, requestId)
      if (i < 0) return prev
      const next = [...prev]
      next[i] = { role: 'ai', text: reason, ts: Date.now(), isError: true }
      return next
    })
  }, [])

  // (Re)starts a request's timeout. Map.set on an existing key keeps its
  // position, so re-arming on progress does not disturb the send order.
  const armReplyTimer = useCallback((requestId) => {
    const timers = replyTimersRef.current
    clearTimeout(timers.get(requestId))
    timers.set(requestId, setTimeout(() => {
      timers.delete(requestId)
      failPending(requestId, 'No response from the server. Check your connection and try again.')
    }, REPLY_TIMEOUT_MS))
  }, [failPending])

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
      const timers = replyTimersRef.current

      // The request this frame is about. Current servers quote request_id
      // back. Older ones send none, so their frame goes to the newest
      // placeholder still waiting — the last "Thinking…" bubble, as before.
      // A frame that does name a request is never redirected to another one.
      const requestId = data.request_id || [...timers.keys()].pop()

      // Progress: the server is still on it. Show what it is doing and restart
      // that request's timeout, since it is evidently alive. Nothing else
      // changes — the placeholder keeps waiting for its answer.
      if (data.type === 'progress') {
        if (!timers.has(requestId)) return   // answered, timed out or cleared
        armReplyTimer(requestId)
        setMessages(prev => {
          const i = findPending(prev, requestId)
          if (i < 0) return prev
          const next = [...prev]
          next[i] = { ...prev[i], progress: asText(data.message) }
          return next
        })
        return
      }

      // Any other typed frame is not an answer. Untyped ones come from older
      // servers, and are an answer only if they carry a response or an error.
      if (data.type && data.type !== 'response') return
      const text = asText(data.response_text)
      if (!data.type && !text && !data.error) return

      // The server answered, so the placeholder is no longer stranded.
      clearReplyTimer(requestId)

      const errors = Array.isArray(data.errors) ? data.errors.map(toProblem) : []
      // An error frame has no response text. The placeholder used to stay on
      // screen as a permanent "Thinking…" because only a successful reply
      // replaced it.
      const reply = {
        role: 'ai',
        text: text || asText(data.error) ||
          (errors.length ? 'Something went wrong — details below.' : 'The server sent an empty reply.'),
        ts: Date.now(),
        isError: data.status === 'error' || (!text && !!data.error),
        // Rendered as markdown even when it is an error; the client's own
        // notices (timeout, offline) are not.
        fromServer: true,
        errors,
      }

      setMessages(prev => {
        const i = findPending(prev, requestId)
        if (i < 0) return [...prev, reply]
        const next = [...prev]
        next[i] = reply
        return next
      })

      if (text && ttsEnabledRef.current) {
        speak(
          text,
          (vol) => setOrbAmplitude(vol * 4),
          () => setOrbAmplitude(0)
        )
      }
    })

    ensureConnection()
  }, [onLogout, armReplyTimer, clearReplyTimer])

  // ── Phone channel (android server /ui) ─────────────────
  useEffect(() => onPhoneStatus(setPhone), [])

  useEffect(() => onPhoneFrame((f) => {
    switch (f.type) {
      case 'ready':
        setMessages(prev => {
          let next = prev
          for (const p of (Array.isArray(f.prompts) ? f.prompts : [])) {
            if (!next.some(m => m.role === 'prompt' && m.id === p.id)) next = insertCard(next, promptMessage(p))
          }
          for (const a of (Array.isArray(f.activity) ? f.activity : [])) next = applyActivity(next, a)
          // Prompts that closed while this window was disconnected.
          const open = new Set((f.prompts || []).map(p => p.id))
          return next.map(m => (m.role === 'prompt' && (m.status === 'open' || m.status === 'sent') && !open.has(m.id))
            ? { ...m, status: 'expired' } : m)
        })
        break
      case 'prompt':
        setMessages(prev => (prev.some(m => m.role === 'prompt' && m.id === f.id) ? prev : insertCard(prev, promptMessage(f))))
        break
      case 'prompt_closed':
        setMessages(prev => prev.map(m => (m.role === 'prompt' && m.id === f.id ? { ...m, status: asText(f.outcome) || 'closed' } : m)))
        break
      case 'activity': {
        // A phone task is alive: keep the Brain reply that is waiting on it from timing out.
        const pending = [...replyTimersRef.current.keys()].pop()
        if (pending) armReplyTimer(pending)
        setMessages(prev => applyActivity(prev, f))
        break
      }
      case 'event':
        setMessages(prev => insertCard(prev, { role: 'event', device: asText(f.device), text: eventText(f), ts: Date.now() }))
        break
      case 'stop_ack':
        if (!f.stopped) {
          setMessages(prev => prev.map(m => (m.role === 'activity' && m.device === f.device && m.stopping
            ? { ...m, stopping: false } : m)))
        }
        break
      default:
    }
  }), [armReplyTimer])

  const handlePromptAnswer = useCallback((id, frame) => {
    const sent = sendPhone({ ...frame, id })
    setMessages(prev => prev.map(m => (m.role === 'prompt' && m.id === id ? { ...m, status: sent ? 'sent' : 'not sent' } : m)))
  }, [])

  const handleStopTask = useCallback((item) => {
    if (!sendPhone({ type: 'stop', device: item.device })) return
    setMessages(prev => prev.map(m => (m.role === 'activity' && m.taskId === item.taskId ? { ...m, stopping: true } : m)))
  }, [])

  // Don't leave timers running past unmount.
  useEffect(() => clearAllReplyTimers, [clearAllReplyTimers])

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
        // Their placeholders are gone, so their timeouts go too.
        clearAllReplyTimers()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [clearAllReplyTimers])

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

    // Sent first, because the placeholder needs the request id that the
    // server's progress frames and answer will quote back.
    const { status, requestId } = sendMessage(text, attachments)

    setMessages(prev => [
      ...prev,
      {
        role: 'user',
        text: text || '(file attachment)',
        ts: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      { role: 'ai', text: '', thinking: true, requestId, progress: '', ts: Date.now() },
    ])

    if (status === 'offline') {
      // Nothing is going to reconnect by itself, so say so now rather than
      // showing a placeholder that can never resolve.
      failPending(requestId, 'Not connected — your message was not sent. Sign in again and retry.')
      return
    }

    armReplyTimer(requestId)
  }, [armReplyTimer, failPending])

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

  // The server pushed a frame or stream to this device. On narrow screens the
  // vision column is a hidden drawer, so open it — otherwise the answer's
  // picture would arrive somewhere the user cannot see.
  const handleVisionActivity = useCallback(() => setVisionOpen(true), [])

  // ── Mic volume → orb ──────────────────────────────────
  const handleMicVolume = useCallback((vol) => {
    setOrbAmplitude(vol * 5)
  }, [])

  // ── TTS toggle ─────────────────────────────────────────
  // Shared by the speaker button and the Settings toggle so the two can never
  // disagree about whether TTS is on.
  const setTts = useCallback((next) => {
    localStorage.setItem('nandi_tts_enabled', next)
    if (!next) stopTts()
    setTtsEnabled(next)
  }, [])

  const handleTtsToggle = useCallback(() => {
    // Read through the ref, so this does not need `ttsEnabled` as a dependency
    // and the state updater stays free of side effects.
    setTts(!ttsEnabledRef.current)
  }, [setTts])

  const handleShowLogsChange = useCallback((next) => {
    localStorage.setItem('nandi_show_logs', next)
    setShowLogs(next)
    // Leaving the mobile drawer flagged open would make it reappear the moment
    // logs were switched back on.
    if (!next) setLogsOpen(false)
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
    <div className={`app-layout${showLogs ? '' : ' app-layout--no-logs'}`}>
      {/* ─── Header ─── */}
      <header className="app-header">
        <div className="app-header__left">
          <img src="/logo.png" alt="Nandi AI" className="app-header__logo" />
          <span className="app-header__brand">NANDI AI</span>
          <span className="app-header__status">
            <span className={`app-header__dot${connected ? '' : ' app-header__dot--off'}`} />
            {connected ? 'Online' : 'Offline'}
          </span>
          {phone.devices.length > 0 && (
            <span className="app-header__phone app-header__phone--on" title={phone.devices.map(d => `${d.id}: ${d.model || ''}`).join('\n')}>
              📱 {phone.devices.map(d => deviceName(d.id)).join(', ')} online
            </span>
          )}
        </div>

        <div className="app-header__center">
          <span className="app-header__time">{time}</span>
          <span className="app-header__date">{date}</span>
        </div>

        {/* Each label is a separate element from its icon so it can be dropped
            on phones, where the three labelled buttons need ~292px of a 375px
            header and Settings ended up off-screen. title/aria-label carry the
            meaning once the text is hidden. */}
        <div className="app-header__right">
          {showLogs && (
            <button
              className="app-header__toggle-logs"
              onClick={() => setLogsOpen(prev => !prev)}
              title="Activity logs"
              aria-label="Activity logs"
            >
              <IconLogs size={15} />
              <span className="app-header__btn-label">Logs</span>
            </button>
          )}
          <button
            className="app-header__toggle-logs"
            onClick={() => setVisionOpen(prev => !prev)}
            title="Vision"
            aria-label="Vision"
          >
            <span aria-hidden="true">👁</span>
            <span className="app-header__btn-label">Vision</span>
          </button>
          <button
            className="app-header__settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <IconSettings size={17} />
            <span className="app-header__btn-label">Settings</span>
          </button>
        </div>
      </header>

      {/* ─── Log Sidebar (left) ─── */}
      {/* Not rendered at all when the setting is off, so the log socket is
          closed rather than merely hidden. */}
      {showLogs && (
        <aside className={`log-sidebar${logsOpen ? ' log-sidebar--open' : ''}`}>
          <LogPanel />
        </aside>
      )}

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

            {messages.map((msg, i) => (msg.role === 'prompt' || msg.role === 'activity' || msg.role === 'event') ? (
              <div key={msg.id || msg.taskId || i} className="msg msg--ai">
                <span className="msg__label">{deviceName(msg.device).replace(/^./, c => c.toUpperCase())}</span>
                {msg.role === 'prompt' && <PromptCard msg={msg} onAnswer={handlePromptAnswer} />}
                {msg.role === 'activity' && <ActivityCard item={msg} onStop={handleStopTask} />}
                {msg.role === 'event' && <div className="phone-event">{msg.text}</div>}
              </div>
            ) : (
              <div key={i} className={`msg msg--${msg.role}`}>
                <span className="msg__label">
                  {msg.role === 'user' ? 'You' : 'Nandi'}
                </span>
                <div className="msg__bubble">
                  {msg.thinking ? (
                    // What the server says it is doing, once it says anything.
                    <span className={`msg__thinking${msg.progress ? ' msg__thinking--progress' : ''}`}>
                      {msg.progress || 'Thinking…'}
                    </span>
                  ) : msg.isError && !msg.fromServer ? (
                    // The client's own notices (timeout, offline): plain text.
                    <span className="msg__error-text">{msg.text}</span>
                  ) : msg.role === 'ai' ? (
                    // Only the assistant's text is markdown. The user's own
                    // message is shown exactly as typed.
                    <>
                      {msg.isError ? (
                        <div className="msg__error-text"><Markdown>{msg.text}</Markdown></div>
                      ) : (
                        <Markdown>{msg.text}</Markdown>
                      )}
                      {msg.errors?.length > 0 && <ProblemList errors={msg.errors} />}
                    </>
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
          onActivity={handleVisionActivity}
        />
      </aside>

      {/* ─── Settings ─── */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
          ttsEnabled={ttsEnabled}
          onTtsChange={setTts}
          showLogs={showLogs}
          onShowLogsChange={handleShowLogsChange}
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
