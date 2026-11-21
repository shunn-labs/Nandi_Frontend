import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import TopBar, { AmbientClock } from './TopBar.jsx'
import Core from './Core.jsx'
import CardStack from './CardStack.jsx'
import JobStrip from './JobStrip.jsx'
import Captions from './Captions.jsx'
import Toasts from './Toasts.jsx'
import ChatInput from './ChatInput.jsx'
import Console from './Console.jsx'
import CommandPalette from './CommandPalette.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import VisionBox from './VisionBox.jsx'
import Markdown from './Markdown.jsx'
import ProblemList from './ProblemList.jsx'
import PromptCard from './PromptCard.jsx'
import { applyActivity } from './ActivityCard.jsx'
import useVisionBoxes from '../hooks/useVisionBoxes.js'
import {
  ensureConnection,
  onAuthFailure,
  onConnectionChange,
  onMessage,
  sendMessage,
} from '../lib/wsAdapter.js'
import { speak, stop as stopTts } from '../lib/ttsPlayer.js'
import { onUiFrame, sendDisplay } from '../lib/visionControl.js'
import { THEMES, SCHEMES, applyTheme, applyScheme, loadTheme, loadScheme } from '../lib/themes.js'
import {
  asText, toProblem, findPending, insertCard, promptMessage, eventMessage,
  isOpenPrompt, cardLabel, needsPanel, firstSentence,
} from '../lib/messages.js'

// How long a "Thinking…" placeholder may go without hearing anything before it
// is called a failure. Every progress frame (the server sends a heartbeat at
// least every ~15 s) restarts it, so a long vision job that keeps reporting in
// is never cut off — only silence is.
const REPLY_TIMEOUT_MS = 90000

// Answered prompts stay on screen this long, so their outcome can be read.
const DONE_PROMPT_MS = 4000

// Only the newest long answers keep a card; older ones live in the transcript.
const MAX_ANSWER_CARDS = 3

// Two presses of Esc within this window clear the whole screen.
const DOUBLE_ESC_MS = 600

// What a vision card shows under its title: what it is and where it comes
// from (the stream id, or the camera a snapshot was taken from).
function visionSource(b) {
  if (b.type === 'frame') return b.camera ? `snapshot · ${b.camera}` : 'snapshot'
  return `${b.type === 'camera' ? 'this device' : 'live'} · ${b.streamId}`
}
// Shape of a vision card until its picture has loaded.
const DEFAULT_ASPECT = 16 / 9

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/**
 * The main screen. A voice column on the left (the dotted core, captions and a
 * compact bar) and, once Nandi shows anything, a stack of cards on the right.
 * A folded console runs along the bottom. This component owns the conversation
 * (the chat socket, the brain's display channel) and decides what goes where.
 */
export default function ChatView({ onLogout }) {
  // ── Conversation ───────────────────────────────────────
  const [messages, setMessages] = useState([])
  const [connected, setConnected] = useState(false)
  // What each capability has connected now ({android: [{id, name, ...}]}), from the brain.
  const [capDevices, setCapDevices] = useState({})

  // ── Settings ───────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem('nandi_tts_enabled') !== 'false')
  const [showLogs, setShowLogs] = useState(() => localStorage.getItem('nandi_show_logs') !== 'false')
  const [theme, setThemeState] = useState(loadTheme)
  const [scheme, setSchemeState] = useState(loadScheme)

  // ── Screen ─────────────────────────────────────────────
  // Prompt and answer cards the user dismissed (or that finished). They stay in
  // the transcript; only their card goes.
  const [hidden, setHidden] = useState(() => new Set())
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleTab, setConsoleTab] = useState('transcript')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [ambient, setAmbient] = useState(false)
  const [toasts, setToasts] = useState([])
  const [caption, setCaption] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  // Each vision panel's picture shape (width / height), once its media loads.
  const [aspects, setAspects] = useState({})

  // ── Voice ──────────────────────────────────────────────
  const [speaking, setSpeaking] = useState(false)
  const [recording, setRecording] = useState(false)
  // Mic / voice level for the core. A ref: it changes 60 times a second.
  const amplitudeRef = useRef(0)

  const vision = useVisionBoxes()
  const chatInputRef = useRef(null)
  const stackRef = useRef(null)
  // Kept just under the core by Core itself, wherever the core moves.
  const hintRef = useRef(null)
  const stripRef = useRef(null)
  const coreAnchors = useMemo(() => [hintRef, stripRef], [])
  const dragCountRef = useRef(0)
  const lastEscRef = useRef(0)

  // onMessage is registered once, so it closes over the first render's
  // `ttsEnabled`. A ref keeps the callback reading today's value.
  const ttsEnabledRef = useRef(ttsEnabled)
  useEffect(() => { ttsEnabledRef.current = ttsEnabled }, [ttsEnabled])
  const recordingRef = useRef(false)
  useEffect(() => { recordingRef.current = recording }, [recording])

  const toast = useCallback((title, body = '', tone) => {
    setToasts(prev => [...prev.slice(-3), { id: `${Date.now()}-${Math.random()}`, title, body, tone }])
  }, [])
  const dismissToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), [])

  // ── Reply timeouts ─────────────────────────────────────
  // One timeout per outstanding request: requestId → timeout id. The map keeps
  // send order, so its last key is the newest placeholder still waiting.
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
    setCaption(c => ({ key: Date.now(), echo: c?.echo, text: reason, short: true, isError: true }))
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

  useEffect(() => clearAllReplyTimers, [clearAllReplyTimers])

  // ── Speaking ───────────────────────────────────────────
  const say = useCallback((text) => {
    setSpeaking(true)
    speak(
      text,
      (vol) => { amplitudeRef.current = Math.min(1, vol * 4) },
      () => { amplitudeRef.current = 0; setSpeaking(false) },
    )
  }, [])

  // ── Chat socket ────────────────────────────────────────
  useEffect(() => {
    onConnectionChange((val) => setConnected(val))

    // An expired or invalid token used to produce an endless reconnect loop.
    // Send the user back to login instead.
    onAuthFailure(() => {
      localStorage.removeItem('user_token')
      onLogout()
    })

    onMessage((data) => {
      const timers = replyTimersRef.current

      // The request this frame is about. Current servers quote request_id
      // back. Older ones send none, so their frame goes to the newest
      // placeholder still waiting. A frame that names a request is never
      // redirected to another one.
      const requestId = data.request_id || [...timers.keys()].pop()

      // Progress: the server is still on it. Show what it is doing and restart
      // that request's timeout.
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

      clearReplyTimer(requestId)

      const errors = Array.isArray(data.errors) ? data.errors.map(toProblem) : []
      const replyText = text || asText(data.error) ||
        (errors.length ? 'Something went wrong — details below.' : 'The server sent an empty reply.')
      const panel = needsPanel(replyText, errors)
      const reply = {
        role: 'ai',
        id: `answer-${requestId || Date.now()}`,
        text: replyText,
        ts: Date.now(),
        isError: data.status === 'error' || (!text && !!data.error),
        // Rendered as markdown even when it is an error; the client's own
        // notices (timeout, offline) are not.
        fromServer: true,
        errors,
        panel,
      }

      setMessages(prev => {
        const i = findPending(prev, requestId)
        if (i < 0) return [...prev, reply]
        const next = [...prev]
        next[i] = reply
        return next
      })
      setCaption(c => ({
        key: Date.now(), echo: c?.echo, isError: reply.isError,
        text: panel ? firstSentence(replyText) : replyText, short: panel,
      }))

      if (text && ttsEnabledRef.current) say(text)
    })

    ensureConnection()
  }, [onLogout, armReplyTimer, clearReplyTimer, say])

  // ── Cards, live jobs, devices and events (brain display channel) ─────
  useEffect(() => onUiFrame((f) => {
    switch (f.action) {
      case 'ui_snapshot':
        setCapDevices(f.devices && typeof f.devices === 'object' ? f.devices : {})
        setMessages(prev => {
          let next = prev
          for (const p of (Array.isArray(f.prompts) ? f.prompts : [])) {
            if (!next.some(m => m.role === 'prompt' && m.id === p.id)) next = insertCard(next, promptMessage(p))
          }
          for (const a of (Array.isArray(f.activities) ? f.activities : [])) next = applyActivity(next, a)
          // Cards that closed while this screen was disconnected.
          const open = new Set((f.prompts || []).map(p => p.id))
          return next.map(m => (m.role === 'prompt' && (m.status === 'open' || m.status === 'sent') && !open.has(m.id))
            ? { ...m, status: 'expired' } : m)
        })
        break
      case 'ui_disconnected':
        setCapDevices({})
        break
      case 'devices':
        setCapDevices(prev => ({ ...prev, [asText(f.domain)]: Array.isArray(f.devices) ? f.devices : [] }))
        break
      case 'prompt':
        setMessages(prev => (prev.some(m => m.role === 'prompt' && m.id === f.id) ? prev : insertCard(prev, promptMessage(f))))
        break
      case 'prompt_closed':
        setMessages(prev => prev.map(m => (m.role === 'prompt' && m.id === f.id ? { ...m, status: asText(f.outcome) || 'closed' } : m)))
        break
      case 'prompt_invalid':
        setMessages(prev => prev.map(m => (m.role === 'prompt' && m.id === f.id ? { ...m, status: 'invalid' } : m)))
        break
      case 'activity': {
        // A job is alive: keep the reply that is waiting on it from timing out.
        const pending = [...replyTimersRef.current.keys()].pop()
        if (pending && f.state === 'running') armReplyTimer(pending)
        setMessages(prev => applyActivity(prev, f))
        break
      }
      case 'activity_stop_ack':
        if (!f.stopped) {
          setMessages(prev => prev.map(m => (m.role === 'activity' && m.id === f.id ? { ...m, stopping: false } : m)))
        }
        break
      case 'event': {
        const ev = eventMessage(f)
        setMessages(prev => insertCard(prev, ev))
        toast(`${cardLabel(ev)} · ${ev.title}`, ev.text === ev.title ? '' : ev.text.slice(ev.title.length + 3))
        break
      }
      default:
    }
  }), [armReplyTimer, toast])

  const handlePromptAnswer = useCallback((id, action, content) => {
    const sent = sendDisplay({ type: 'prompt_answer', id, action, content: content || {} })
    setMessages(prev => prev.map(m => (m.role === 'prompt' && m.id === id ? { ...m, status: sent ? 'sent' : 'not sent' } : m)))
  }, [])

  const handleStopTask = useCallback((item) => {
    if (!sendDisplay({ type: 'activity_stop', id: item.id })) return
    setMessages(prev => prev.map(m => (m.role === 'activity' && m.id === item.id ? { ...m, stopping: true } : m)))
  }, [])

  // ── Sending ────────────────────────────────────────────
  const handleSend = useCallback((text, attachments) => {
    if (!text && attachments.length === 0) return
    stopTts()
    setAmbient(false)

    // Sent first, because the placeholder needs the request id that the
    // server's progress frames and answer will quote back.
    const { status, requestId } = sendMessage(text, attachments)

    setMessages(prev => [
      ...prev,
      { role: 'user', text: text || '(file attachment)', ts: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined },
      { role: 'ai', text: '', thinking: true, requestId, progress: '', ts: Date.now() },
    ])
    setCaption({ key: Date.now(), echo: text || 'Sent a file', text: '', short: true })

    if (status === 'offline') {
      // Nothing is going to reconnect by itself, so say so now rather than
      // showing a placeholder that can never resolve.
      failPending(requestId, 'Not connected — your message was not sent. Sign in again and retry.')
      return
    }
    armReplyTimer(requestId)
  }, [armReplyTimer, failPending])

  const clearConversation = useCallback(() => {
    setMessages([])
    setCaption(null)
    clearAllReplyTimers()
  }, [clearAllReplyTimers])

  // A frame from a vision panel goes through the normal upload pipeline, so it
  // appears as an attachment chip above the bar exactly like a dropped file.
  const handleVisionCapture = useCallback((file) => {
    window.dispatchEvent(new CustomEvent('nandi-drop-files', { detail: [file] }))
    setTimeout(() => chatInputRef.current?.focus(), 50)
  }, [])

  const handleMicVolume = useCallback((vol) => { amplitudeRef.current = Math.min(1, vol * 5) }, [])

  // ── Settings ───────────────────────────────────────────
  const setTts = useCallback((next) => {
    localStorage.setItem('nandi_tts_enabled', next)
    if (!next) stopTts()
    setTtsEnabled(next)
  }, [])

  const handleShowLogsChange = useCallback((next) => {
    localStorage.setItem('nandi_show_logs', next)
    setShowLogs(next)
  }, [])

  const setTheme = useCallback((key) => setThemeState(applyTheme(key)), [])
  const setScheme = useCallback((key) => setSchemeState(applyScheme(key)), [])
  const cycleTheme = useCallback(() => {
    const keys = Object.keys(THEMES)
    setThemeState(prev => applyTheme(keys[(keys.indexOf(prev) + 1) % keys.length]))
  }, [])

  // Camera failures used to be an inline notice in the vision column.
  useEffect(() => {
    if (!vision.cameraError) return
    toast('Camera', vision.cameraError, 'alert')
    vision.clearCameraError()
  }, [vision.cameraError, vision.clearCameraError, toast])

  // ── What is on screen ──────────────────────────────────
  const setAspect = useCallback((id, ratio) => {
    setAspects(prev => (Math.abs((prev[id] || 0) - ratio) < 0.01 ? prev : { ...prev, [id]: ratio }))
  }, [])

  // Newest first, as the card stack shows them.
  const cards = useMemo(() => {
    const list = vision.boxes.map(b => ({
      id: b.id, at: b.at, title: b.label, source: visionSource(b),
      aspect: aspects[b.id] || DEFAULT_ASPECT,
      content: <VisionBox box={b} onCapture={handleVisionCapture} onAspect={(r) => setAspect(b.id, r)} />,
    }))
    const answers = messages.filter(m => m.role === 'ai' && m.panel).slice(-MAX_ANSWER_CARDS)
    for (const m of messages) {
      if (hidden.has(m.id)) continue
      if (m.role === 'prompt') {
        const open = isOpenPrompt(m)
        list.push({
          id: m.id, at: m.ts, alert: open, title: cardLabel(m), source: open ? 'needs your answer' : 'done',
          content: <PromptCard msg={m} onAnswer={handlePromptAnswer} />,
        })
      } else if (answers.includes(m)) {
        list.push({
          id: m.id, at: m.ts, title: 'Answer',
          source: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          content: (
            <div className={`answer${m.isError ? ' msg__error-text' : ''}`}>
              <Markdown>{m.text}</Markdown>
              {m.errors?.length > 0 && <ProblemList errors={m.errors} />}
            </div>
          ),
        })
      }
    }
    return list.sort((a, b) => b.at - a.at)
  }, [vision.boxes, aspects, messages, hidden, handleVisionCapture, handlePromptAnswer, setAspect])

  // Answered prompts leave the screen after a moment (they stay in the transcript).
  useEffect(() => {
    const done = messages.filter(m => m.role === 'prompt' && !isOpenPrompt(m) && !hidden.has(m.id))
    if (!done.length) return undefined
    const t = setTimeout(() => setHidden(prev => new Set([...prev, ...done.map(m => m.id)])), DONE_PROMPT_MS)
    return () => clearTimeout(t)
  }, [messages, hidden])

  const isVisionCard = useCallback((id) => vision.boxes.some(b => b.id === id), [vision.boxes])

  const closeCard = useCallback((id) => {
    if (isVisionCard(id)) vision.close(id)
    else setHidden(prev => new Set(prev).add(id))
  }, [isVisionCard, vision])

  const clearStage = useCallback(() => {
    vision.closeAll()
    setHidden(prev => new Set([...prev, ...cards.map(c => c.id)]))
  }, [vision, cards])

  const hasCards = cards.length > 0

  // Opening a stream that is already on screen brings its card to the front.
  const openStream = useCallback((streamId, label) => {
    const existing = vision.boxes.find(b => b.streamId === streamId)
    if (existing) stackRef.current?.goTo(existing.id)
    else vision.openStream(streamId, label)
  }, [vision])

  // ── What Nandi is doing ────────────────────────────────
  const pending = useMemo(() => [...messages].reverse().find(m => m.thinking), [messages])
  const activities = useMemo(() => messages.filter(m => m.role === 'activity'), [messages])
  const runningJob = useMemo(() => [...activities].reverse().find(a => a.state !== 'done'), [activities])
  const promptOpen = messages.some(isOpenPrompt)
  const coreState = !connected ? 'offline'
    : recording ? 'listening'
    : speaking ? 'speaking'
    : promptOpen ? 'needs'
    : runningJob ? 'working'
    : pending ? 'thinking'
    : 'idle'

  const stopAllJobs = useCallback(() => {
    activities.filter(a => a.state !== 'done' && a.can_stop).forEach(handleStopTask)
  }, [activities, handleStopTask])

  // ── Commands (menu and palette) ────────────────────────
  const openConsole = useCallback((tab) => { setConsoleTab(tab); setConsoleOpen(true) }, [])
  const toggleMic = useCallback(() => chatInputRef.current?.toggleMic(), [])

  const menuItems = [
    { label: 'Settings', onSelect: () => setSettingsOpen(true) },
    { label: consoleOpen ? 'Close console' : 'Open console', hint: 'Ctrl `', onSelect: () => setConsoleOpen(o => !o) },
    { label: vision.cameraOn ? 'Stop sharing camera' : 'Share camera', onSelect: vision.toggleCamera },
    { label: ttsEnabled ? 'Captions only' : 'Turn voice on', onSelect: () => setTts(!ttsEnabled) },
    null,
    { label: 'Clear the screen', hint: 'Esc Esc', onSelect: clearStage },
    { label: 'Ambient mode', onSelect: () => setAmbient(true) },
    { label: 'All commands', hint: 'Ctrl K', onSelect: () => setPaletteOpen(true) },
  ]

  const commands = [
    { label: 'Ask Nandi', hint: '/', onSelect: () => chatInputRef.current?.focus() },
    { label: 'Talk', hint: 'hold Space', onSelect: toggleMic },
    { label: 'Open settings', onSelect: () => setSettingsOpen(true) },
    { label: 'Open transcript', hint: 'console', onSelect: () => openConsole('transcript') },
    { label: 'Open logs', hint: 'console', onSelect: () => openConsole('logs') },
    { label: 'Open activity', hint: 'console', onSelect: () => openConsole('activity') },
    { label: 'Open devices', hint: 'console', onSelect: () => openConsole('devices') },
    { label: consoleOpen ? 'Close console' : 'Open console', hint: 'Ctrl `', onSelect: () => setConsoleOpen(o => !o) },
    { label: vision.cameraOn ? 'Stop sharing camera' : 'Share camera', onSelect: vision.toggleCamera },
    { label: ttsEnabled ? 'Captions only' : 'Turn voice on', onSelect: () => setTts(!ttsEnabled) },
    { label: 'Clear the screen', hint: 'Esc Esc', onSelect: clearStage },
    { label: 'Clear the conversation', hint: 'Ctrl L', onSelect: clearConversation },
    { label: 'Stop what is running', hint: 'Shift Esc', onSelect: stopAllJobs },
    { label: 'Ambient mode', onSelect: () => setAmbient(true) },
    { label: 'Show all cards', hint: 'O', onSelect: () => stackRef.current?.toggleOverview(true) },
    ...Object.entries(SCHEMES).map(([key, label]) => ({
      label: `Appearance: ${label}${key === scheme ? ' (current)' : ''}`, hint: 'look', onSelect: () => setScheme(key),
    })),
    ...Object.entries(THEMES).map(([key, t]) => ({
      label: `Accent: ${t.name}${key === theme ? ' (current)' : ''}`, hint: 'T', onSelect: () => setTheme(key),
    })),
    { label: 'Sign out', onSelect: onLogout },
  ]

  // ── Keyboard ───────────────────────────────────────────
  // Read through a ref so the listener is attached once.
  const keysRef = useRef(null)
  keysRef.current = { ambient, paletteOpen, settingsOpen, speaking, clearStage, stopAllJobs, cycleTheme, clearConversation, toggleMic }

  useEffect(() => {
    const onKeyDown = (e) => {
      const k = keysRef.current
      const mod = e.ctrlKey || e.metaKey
      if (k.ambient) { if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) setAmbient(false); return }
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); return }
      if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); k.clearConversation(); return }
      if (mod && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); setConsoleOpen(o => !o); return }
      if (k.paletteOpen || k.settingsOpen) return

      if (e.key === 'Escape') {
        if (e.shiftKey) { k.stopAllJobs(); return }
        if (k.speaking) { stopTts(); return }
        const now = performance.now()
        if (now - lastEscRef.current < DOUBLE_ESC_MS) { k.clearStage(); lastEscRef.current = 0; return }
        lastEscRef.current = now
        const stack = stackRef.current
        if (stack?.overview) stack.toggleOverview(false)
        else stack?.closeFront()
        return
      }
      if (isTyping(document.activeElement) || mod || e.altKey) return
      if (e.key === '/') { e.preventDefault(); chatInputRef.current?.focus(); return }
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); stackRef.current?.step(1); return }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); stackRef.current?.step(-1); return }
      if (e.key === 'o' || e.key === 'O') { stackRef.current?.toggleOverview(); return }
      if (e.key === 't' || e.key === 'T') { k.cycleTheme(); return }
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault()
        if (!recordingRef.current) k.toggleMic()
      }
    }
    // Hold Space to talk: letting go stops the recording and sends it.
    const onKeyUp = (e) => {
      if (e.code === 'Space' && recordingRef.current && !isTyping(document.activeElement)) {
        e.preventDefault()
        keysRef.current.toggleMic()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ── Global drag-and-drop ───────────────────────────────
  useEffect(() => {
    const onDragEnter = (e) => { e.preventDefault(); dragCountRef.current++; setIsDragging(true) }
    const onDragLeave = (e) => { e.preventDefault(); if (--dragCountRef.current === 0) setIsDragging(false) }
    const onDragOver = (e) => e.preventDefault()
    const onDrop = (e) => {
      e.preventDefault()
      dragCountRef.current = 0
      setIsDragging(false)
      if (e.dataTransfer.files.length) {
        window.dispatchEvent(new CustomEvent('nandi-drop-files', { detail: e.dataTransfer.files }))
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

  const showHint = messages.length === 0 && !hasCards && coreState === 'idle'

  return (
    <div className={`screen${hasCards ? ' screen--cards' : ''}${ambient ? ' screen--ambient' : ''}`}
      onPointerDownCapture={ambient ? () => setAmbient(false) : undefined}>
      <TopBar coreState={coreState} menuItems={menuItems} scheme={scheme} onScheme={setScheme} />

      <main className="screen__main">
        <section className="voice" aria-label="Nandi">
          <Core state={coreState} hasCards={hasCards} large={ambient}
            amplitudeRef={amplitudeRef} anchorRefs={coreAnchors} onActivate={toggleMic} />
          {showHint && (
            <p className="voice__hint" ref={hintRef}>Click the core or hold <kbd>Space</kbd> to talk</p>
          )}
          <div className="voice__strip" ref={stripRef}>
            <JobStrip job={runningJob} pending={pending ? pending.progress : null} onStop={handleStopTask} />
          </div>
          <Captions caption={caption} hold={!!pending || speaking} />
          <div className="voice__bar">
            <ChatInput ref={chatInputRef} onSend={handleSend}
              onMicVolume={handleMicVolume} onRecordingChange={setRecording} />
          </div>
        </section>

        <CardStack ref={stackRef} cards={cards} onClose={closeCard} onClear={clearStage} />
        <Toasts toasts={toasts} onDismiss={dismissToast} />
        {ambient && <AmbientClock />}
      </main>

      <Console
        open={consoleOpen} onToggle={() => setConsoleOpen(o => !o)}
        tab={consoleTab} onTab={setConsoleTab}
        messages={messages} activities={activities} onStopActivity={handleStopTask}
        showLogs={showLogs} connected={connected} capDevices={capDevices}
        vision={{ ...vision, openStream }}
      />

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
          ttsEnabled={ttsEnabled}
          onTtsChange={setTts}
          showLogs={showLogs}
          onShowLogsChange={handleShowLogsChange}
          theme={theme}
          onThemeChange={setTheme}
          scheme={scheme}
          onSchemeChange={setScheme}
        />
      )}

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}

      {isDragging && (
        <div className="drop-overlay">
          <span className="drop-overlay__label">Drop files to attach</span>
        </div>
      )}
    </div>
  )
}
