import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, memo, Suspense } from 'react'
import TopBar, { AmbientClock } from './TopBar.jsx'
import Core from './Core.jsx'
import Stage from './Stage.jsx'
import JobStrip from './JobStrip.jsx'
import Captions from './Captions.jsx'
import Toasts from './Toasts.jsx'
import ChatInput from './ChatInput.jsx'
import Console from './Console.jsx'
import CommandPalette from './CommandPalette.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import AudioStreamsPanel from './AudioStreamsPanel.jsx'
import VisionBox from './VisionBox.jsx'
import Markdown from './Markdown.jsx'
import ProblemList from './ProblemList.jsx'
import PromptCard from './PromptCard.jsx'
import PlanCard from './PlanCard.jsx'
import NotificationCard from './NotificationCard.jsx'
import ActivityCard, { applyActivity } from './ActivityCard.jsx'
import useVisionBoxes from '../hooks/useVisionBoxes.js'
import useStageItems from '../hooks/useStageItems.js'
import { getAmbientDelay, setAmbientDelay } from '../lib/uiPrefs.js'
import {
  ensureConnection,
  onAuthFailure,
  onConnectionChange,
  onMessage,
  sendMessage,
} from '../lib/wsAdapter.js'
import { speak, stop as stopTts, getIsPlaying } from '../lib/ttsPlayer.js'
import { playChime } from '../lib/chime.js'
import { onUiFrame, sendDisplay } from '../lib/visionControl.js'
import { markNotificationsRead } from '../lib/filesApi.js'
import { scheduleText, waitingText } from '../lib/taskText.js'
import { THEMES, SCHEMES, applyTheme, applyScheme, loadTheme, loadScheme } from '../lib/themes.js'
import {
  asText, toProblem, findPending, insertCard, promptMessage, eventMessage, notificationMessage,
  isOpenPrompt, cardLabel, needsPanel, firstSentence,
} from '../lib/messages.js'
import { stripEmotionTag } from '../lib/emotionTag.js'
import { micStreamId, publishMic } from '../lib/audioStreams.js'
import { getDeviceName } from '../lib/clientId.js'

// Voice mode pulls in the Pipecat client and its WebRTC transport — the
// biggest dependency in the app — so it is only fetched the first time
// someone opens it. If that fetch fails (offline, or a tab still running the
// previous deploy asking for a chunk that no longer exists) it degrades to a
// notice instead of taking the whole app down with it.
function VoiceModeUnavailable({ onClose }) {
  return (
    <div className="voice-mode voice-mode--error" role="alert">
      <div className="voice-mode__error">
        <span>Voice mode could not be loaded — the app may have been updated.</span>
        <button className="voice-mode__retry" onClick={() => window.location.reload()}>Reload</button>
        <button className="voice-mode__retry" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

const VoiceMode = lazy(() => import('./VoiceMode.jsx').catch((err) => {
  console.error('[voice] could not load voice mode:', err)
  return { default: VoiceModeUnavailable }
}))

// What the core shows for each voice-mode state. Not `listening`: while the
// user talks the core keeps its own calm state (their voice is the dotted wave
// in the voice-mode panel); it only moves for Nandi.
const VOICE_CORE = { connecting: 'thinking', thinking: 'thinking', speaking: 'speaking' }

// How long a "Thinking…" placeholder may go without hearing anything before it
// is called a failure. Every progress frame (the server sends a heartbeat at
// least every ~15 s) restarts it, so a long vision job that keeps reporting in
// is never cut off — only silence is.
const REPLY_TIMEOUT_MS = 90000

// Answered prompts stay on screen this long, so their outcome can be read.
const DONE_PROMPT_MS = 4000

// A job's card stays on the stage this long after the job ends, so "Done" and
// its summary are seen (it stays in the console's Activity tab).
const DONE_JOB_MS = 60000

// Two presses of Esc within this window clear the whole screen.
const DOUBLE_ESC_MS = 600

// After the last window closes the dock layout stays this long, so windows
// that leave one after another (an answered prompt, then a finished job) do
// not swing the core back and forth.
const DOCK_HOLD_MS = 1500

const NARROW_QUERY = '(max-width: 820px)'

/** True while `on`, and for `ms` after it turns off. */
function useHeld(on, ms) {
  const [held, setHeld] = useState(on)
  useEffect(() => {
    if (on) { setHeld(true); return undefined }
    const t = setTimeout(() => setHeld(false), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on || held
}

/** Phone-sized screens: the stage becomes a scrolling list. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(NARROW_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY)
    if (!mq) return undefined
    const on = () => setNarrow(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return narrow
}

/** A long or structured answer, in its own window. */
const AnswerCard = memo(function AnswerCard({ msg }) {
  return (
    <div className={`answer${msg.isError ? ' msg__error-text' : ''}`}>
      <Markdown>{msg.text}</Markdown>
      {msg.errors?.length > 0 && <ProblemList errors={msg.errors} />}
    </div>
  )
})

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/**
 * The main screen. With nothing to show: the dotted core in the middle, the
 * captions under it and the compact bar bottom-left. Once Nandi shows anything
 * (a photo, a PDF, a stream, a plan) it goes on the stage as a window, the
 * windows share the screen, and the core shrinks into a dock along the bottom:
 * [chat bar] [core] [last command → reply] [job · windows]. A folded console
 * runs along the bottom. This component owns the conversation (the chat
 * socket, the brain's display channel) and decides what goes where.
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
  const [tasksVersion, setTasksVersion] = useState(0)   // bumped by tasks_changed: the Tasks tab reloads
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [ambient, setAmbient] = useState(false)
  const [ambientDelay, setAmbientDelayState] = useState(getAmbientDelay)
  // A window was moved, resized or maximised by hand: offer Auto-arrange.
  const [arranged, setArranged] = useState(false)
  const [toasts, setToasts] = useState([])
  const [caption, setCaption] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  // Each vision panel's picture shape (width / height), once its media loads.
  const [aspects, setAspects] = useState({})

  // ── Voice ──────────────────────────────────────────────
  const [speaking, setSpeaking] = useState(false)
  // Dictation in the bar: idle | recording | transcribing (ChatInput owns it).
  const [micPhase, setMicPhaseState] = useState('idle')
  const micPhaseRef = useRef('idle')
  // Hold Space to talk: set on key-down, so the key-up stops the recording
  // even if it comes before React has re-rendered (a quick tap).
  const spaceHeldRef = useRef(false)
  // Nandi's voice level for the core (never the user's). A ref: it changes 60
  // times a second.
  const voiceLevelRef = useRef(0)
  // Voice mode: a live conversation through the audio server. While it is
  // open its state drives the core and its lines the captions.
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [voiceState, setVoiceState] = useState('idle')
  // ── Live audio ─────────────────────────────────────────
  const [streamsOpen, setStreamsOpen] = useState(false)
  // This device's mic, broadcast to the audio server. Owned here so it keeps
  // running when the live audio panel closes.
  const [micShare, setMicShare] = useState({ on: false, busy: false, error: '' })
  const micShareRef = useRef(null)

  const vision = useVisionBoxes()
  const chatInputRef = useRef(null)
  const stageRef = useRef(null)
  const mainRef = useRef(null)
  const dockRef = useRef(null)
  // The slot in the dock the core moves into while windows are on the stage.
  const globeRef = useRef(null)
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
  const setMicPhase = useCallback((phase) => {
    micPhaseRef.current = phase
    setMicPhaseState(phase)
  }, [])
  // While voice mode is open Nandi already speaks every reply she gives there,
  // and a chat reply read out on top would talk over her.
  const voiceOpenRef = useRef(false)
  useEffect(() => { voiceOpenRef.current = voiceOpen }, [voiceOpen])

  const toast = useCallback((title, body = '', tone, action) => {
    setToasts(prev => [...prev.slice(-3), { id: `${Date.now()}-${Math.random()}`, title, body, tone, action }])
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
      (vol) => { voiceLevelRef.current = Math.min(1, vol * 4) },
      () => { voiceLevelRef.current = 0; setSpeaking(false) },
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
      // A reply may open with an emotion tag ("[calm] ") meant for the speech
      // voice. It is never shown; speak() turns it into the voice's emotion.
      const spoken = asText(data.response_text)
      const text = stripEmotionTag(spoken)
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

      if (text && ttsEnabledRef.current && !voiceOpenRef.current) say(spoken)
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
      case 'notification':
      case 'notifications': {
        // One pushed live, or the unread ones that arrived while this screen
        // was away (sent on connect). Shown here, so marked read.
        const items = (f.action === 'notification' ? [f.notification] : (Array.isArray(f.items) ? f.items : []))
          .filter(n => n && typeof n === 'object')
        if (!items.length) break
        const notes = items.map(notificationMessage).reverse()
        setMessages(prev => notes.reduce((list, n) => (list.some(m => m.id === n.id) ? list : insertCard(list, n)), prev))
        const alert = notes.some(n => n.level === 'error')
        playChime(alert ? 'alert' : 'info')
        if (notes.length === 1) toast(notes[0].title, firstSentence(notes[0].body, 160), notes[0].level === 'error' ? 'alert' : undefined)
        else toast(`${notes.length} notifications`, 'arrived while this screen was away')
        // With voice on, a live reminder is also read out after the chime,
        // unless Nandi is already speaking (a backlog is not read out).
        if (f.action === 'notification' && ttsEnabledRef.current && !getIsPlaying() && !voiceOpenRef.current) {
          const spoken = firstSentence(notes[0].body || notes[0].title, 240)
          if (spoken) setTimeout(() => say(spoken), 900)
        }
        markNotificationsRead(notes.map(n => n.notificationId).filter(Boolean)).catch(() => {})
        break
      }
      case 'tasks_changed': {
        // A task was created, changed or ran. The Tasks tab follows; a new one
        // is confirmed here so the user sees what was set up and when it runs.
        setTasksVersion(v => v + 1)
        if (f.change === 'created' && f.task) {
          toast(`Scheduled · ${f.task.title}`, `${scheduleText(f.task)} · ${waitingText(f.task)}`, undefined,
            { label: 'View tasks', onSelect: () => { setConsoleTab('tasks'); setConsoleOpen(true) } })
        }
        break
      }
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

  // "Change something…" on a plan card is an ordinary chat message: the brain
  // makes a new plan, sends a new card and closes the old one.
  const handlePlanChange = useCallback((text) => {
    handleSend(`Change the plan: ${text}`, [])
  }, [handleSend])

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

  // ── Voice mode ─────────────────────────────────────────
  const openVoice = useCallback(() => {
    if (micPhaseRef.current !== 'idle') return   // dictation has the microphone
    voiceOpenRef.current = true           // now, not after the next commit: no reply may start speaking in between
    stopTts()
    setAmbient(false)
    voiceLevelRef.current = 0
    setVoiceState('connecting')
    setVoiceOpen(true)
  }, [])

  const closeVoice = useCallback(() => {
    voiceOpenRef.current = false
    setVoiceOpen(false)
    setVoiceState('idle')
    voiceLevelRef.current = 0
  }, [])

  // Nandi's level only: VoiceMode keeps the user's for its own dotted wave.
  const handleVoiceLevel = useCallback((amplitude) => { voiceLevelRef.current = Math.min(1, amplitude) }, [])

  // What was heard and what Nandi is saying, as subtitles.
  const handleVoiceCaption = useCallback(({ user, bot }) => {
    if (!user && !bot) return
    setCaption({ key: Date.now(), echo: user, text: bot, short: true })
  }, [])

  // A finished voice exchange. It went through the audio server's own brain
  // socket, so the chat socket never saw it — it is added to the transcript here.
  const handleVoiceTurn = useCallback(({ user, reply, status }) => {
    const ts = Date.now()
    const added = []
    if (user) added.push({ role: 'user', text: user, ts, voice: true })
    if (reply) {
      added.push({ role: 'ai', id: `voice-${ts}`, text: reply, ts, voice: true, fromServer: true,
                   isError: status === 'error', errors: [], panel: false })
    }
    if (added.length) setMessages(prev => [...prev, ...added])
  }, [])

  // ── Live audio streams ─────────────────────────────────
  const listenToStream = useCallback((stream) => {
    vision.openAudioStream(stream.id, stream.name ? `${stream.name} (live)` : stream.id)
    setStreamsOpen(false)
  }, [vision])

  const stopMicShare = useCallback(() => {
    micShareRef.current?.stop?.()
    micShareRef.current = null
  }, [])

  const toggleMicShare = useCallback(async (next) => {
    stopMicShare()
    if (!next) {
      setMicShare({ on: false, busy: false, error: '' })
      return
    }
    // Stands for this attempt until it is replaced or stopped; anything that
    // arrives for an older attempt is dropped.
    const attempt = { stop: null }
    micShareRef.current = attempt
    const current = () => micShareRef.current === attempt
    const lost = (message) => {
      if (!current()) return
      stopMicShare()
      setMicShare({ on: false, busy: false, error: message })
    }
    setMicShare({ on: true, busy: true, error: '' })
    try {
      const share = await publishMic(micStreamId(), `${getDeviceName()} mic`, {
        onState: (state) => {
          if (state === 'failed') lost('The microphone stream dropped. Turn sharing on again to reconnect.')
          else if (state === 'ended') lost('The microphone stopped (unplugged, or access was withdrawn).')
        },
      })
      if (!current()) {
        share.stop()
        return
      }
      attempt.stop = share.stop
      setMicShare({ on: true, busy: false, error: '' })
    } catch (err) {
      if (!current()) return
      micShareRef.current = null
      const denied = err?.name === 'NotAllowedError'
      setMicShare({
        on: false,
        busy: false,
        error: denied
          ? 'Microphone blocked. Allow mic access for this site, then try again.'
          : err?.userMessage || `Could not share the microphone: ${err?.message || 'unknown error'}`,
      })
    }
  }, [stopMicShare])

  // A broadcast must not outlive the signed-in view.
  useEffect(() => stopMicShare, [stopMicShare])

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

  const changeAmbientDelay = useCallback((seconds) => setAmbientDelayState(setAmbientDelay(seconds)), [])

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

  // Everything on the stage, as window descriptors. An unchanged window keeps
  // the same descriptor object, so only windows that changed re-render.
  const items = useStageItems({ boxes: vision.boxes, aspects, messages, hidden })

  // A window's body. Every handler here is stable, so this function is too,
  // and a window's body is rebuilt only when its own item changes.
  const renderContent = useCallback((item) => {
    const m = item.data
    switch (item.type) {
      case 'vision': return <VisionBox box={m} onCapture={handleVisionCapture} onAspect={setAspect} />
      case 'plan': return <PlanCard msg={m} onAnswer={handlePromptAnswer} onChange={handlePlanChange} />
      case 'prompt': return <PromptCard msg={m} onAnswer={handlePromptAnswer} />
      case 'job': return <ActivityCard item={m} onStop={handleStopTask} />
      case 'notification': return <NotificationCard msg={m} />
      case 'answer': return <AnswerCard msg={m} />
      default: return null
    }
  }, [handleVisionCapture, handlePromptAnswer, handlePlanChange, handleStopTask, setAspect])

  // Answered prompts leave the screen after a moment (they stay in the transcript).
  useEffect(() => {
    const done = messages.filter(m => m.role === 'prompt' && !isOpenPrompt(m) && !hidden.has(m.id))
    if (!done.length) return undefined
    const t = setTimeout(() => setHidden(prev => new Set([...prev, ...done.map(m => m.id)])), DONE_PROMPT_MS)
    return () => clearTimeout(t)
  }, [messages, hidden])

  // A finished job's window leaves DONE_JOB_MS after it ended. Counted from when
  // it ended (applyActivity's doneAt), so later messages do not keep it up.
  useEffect(() => {
    const done = messages.filter(m => m.role === 'activity' && m.source === 'job' && m.state === 'done' && !hidden.has(m.id))
    if (!done.length) return undefined
    const due = (m) => (m.doneAt || 0) + DONE_JOB_MS
    const first = Math.min(...done.map(due))
    const t = setTimeout(() => {
      setHidden(prev => new Set([...prev, ...done.filter(m => due(m) <= first).map(m => m.id)]))
    }, Math.max(0, first - Date.now()))
    return () => clearTimeout(t)
  }, [messages, hidden])

  // Closing a window: a vision box goes from the boxes, a card from the stage
  // (it stays in the transcript). Read through a ref so the function is stable.
  const boxesRef = useRef(vision.boxes)
  boxesRef.current = vision.boxes
  const itemsRef = useRef(items)
  itemsRef.current = items
  const visionClose = vision.close
  const visionCloseAll = vision.closeAll
  const closeCard = useCallback((id) => {
    if (boxesRef.current.some(b => b.id === id)) visionClose(id)
    else setHidden(prev => new Set(prev).add(id))
  }, [visionClose])

  const clearStage = useCallback(() => {
    visionCloseAll()
    setHidden(prev => new Set([...prev, ...itemsRef.current.map(c => c.id)]))
  }, [visionCloseAll])

  const hasItems = items.length > 0
  const narrow = useNarrow()
  const stageMode = useHeld(hasItems, DOCK_HOLD_MS)

  // Opening a stream that is already on screen brings its window to the front.
  const visionOpenStream = vision.openStream
  const openStream = useCallback((streamId, label) => {
    const existing = boxesRef.current.find(b => b.streamId === streamId && b.type !== 'audio_stream')
    if (existing) stageRef.current?.focus(existing.id)
    else visionOpenStream(streamId, label)
  }, [visionOpenStream])
  const consoleVision = useMemo(() => ({ ...vision, openStream }), [vision, openStream])

  // The dock's height, for the stage's bottom edge. Written straight to a CSS
  // variable: it changes with the bar (voice mode, attachments), and a React
  // state per change would re-render the whole screen.
  useEffect(() => {
    const dock = dockRef.current, main = mainRef.current
    if (!dock || !main) return undefined
    const ro = new ResizeObserver(() => main.style.setProperty('--dock-h', `${Math.ceil(dock.offsetHeight)}px`))
    ro.observe(dock)
    return () => ro.disconnect()
  }, [])

  // ── What Nandi is doing ────────────────────────────────
  const pending = useMemo(() => [...messages].reverse().find(m => m.thinking), [messages])
  const activities = useMemo(() => messages.filter(m => m.role === 'activity'), [messages])
  const runningJob = useMemo(() => [...activities].reverse().find(a => a.state !== 'done'), [activities])
  const promptOpen = messages.some(isOpenPrompt)
  // The core moves for Nandi only. In voice mode its connecting / thinking /
  // speaking states drive it; while the user talks (dictation, or voice mode
  // listening) it keeps whatever calm state it would otherwise show.
  const voiceCore = voiceOpen ? VOICE_CORE[voiceState] : null
  const coreState = voiceCore ? voiceCore
    : !connected && !voiceOpen ? 'offline'
    : speaking ? 'speaking'
    : promptOpen ? 'needs'
    : runningJob ? 'working'
    : micPhase === 'transcribing' || pending ? 'thinking'
    : 'idle'
  const coreMode = ambient ? 'ambient' : stageMode ? (narrow ? 'narrow-dock' : 'dock') : 'center'

  const stopAllJobs = useCallback(() => {
    activities.filter(a => a.state !== 'done' && a.can_stop).forEach(handleStopTask)
  }, [activities, handleStopTask])

  // ── Ambient mode, by itself ────────────────────────────
  // After a while with no input and nothing going on, only the core and a
  // clock stay. Never while anything is on the stage (a video being watched
  // has no input either), Nandi is busy or talking, or a panel is open.
  const lastInputRef = useRef(Date.now())
  useEffect(() => {
    const touch = () => { lastInputRef.current = Date.now() }
    const opts = { passive: true, capture: true }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']
    events.forEach(e => window.addEventListener(e, touch, opts))
    return () => events.forEach(e => window.removeEventListener(e, touch, opts))
  }, [])
  // Nandi doing something counts as activity too.
  useEffect(() => { lastInputRef.current = Date.now() }, [messages, caption, ambient])
  const ambientGate = useRef({})
  ambientGate.current = {
    ambient, delay: ambientDelay,
    blocked: micPhase !== 'idle' || speaking || !!pending || promptOpen || !!runningJob || voiceOpen
      || paletteOpen || settingsOpen || consoleOpen || streamsOpen || isDragging || hasItems,
  }
  useEffect(() => {
    const id = setInterval(() => {
      const g = ambientGate.current
      if (g.ambient || !g.delay || g.blocked || document.hidden) return
      if (Date.now() - lastInputRef.current >= g.delay * 1000) setAmbient(true)
    }, 5000)
    return () => clearInterval(id)
  }, [])
  // …and it steps aside when Nandi has something to show or say.
  const itemCount = items.length
  const prevItemCount = useRef(itemCount)
  useEffect(() => {
    if (itemCount > prevItemCount.current) setAmbient(false)
    prevItemCount.current = itemCount
  }, [itemCount])
  useEffect(() => { if (speaking || promptOpen) setAmbient(false) }, [speaking, promptOpen])

  // ── Commands (menu and palette) ────────────────────────
  const openConsole = useCallback((tab) => { setConsoleTab(tab); setConsoleOpen(true) }, [])
  // Dictation; not during voice mode, which already has the microphone.
  const toggleMic = useCallback(() => {
    if (!voiceOpenRef.current) chatInputRef.current?.toggleMic()
  }, [])
  const openStreams = useCallback(() => setStreamsOpen(true), [])
  const autoArrange = useCallback(() => stageRef.current?.autoArrange(), [])

  const menuItems = [
    { label: 'Settings', onSelect: () => setSettingsOpen(true) },
    { label: consoleOpen ? 'Close console' : 'Open console', hint: 'Ctrl `', onSelect: () => setConsoleOpen(o => !o) },
    { label: 'Files', onSelect: () => openConsole('files') },
    { label: 'Scheduled tasks', onSelect: () => openConsole('tasks') },
    { label: voiceOpen ? 'End voice mode' : 'Voice mode', onSelect: voiceOpen ? closeVoice : openVoice },
    { label: 'Live audio', onSelect: openStreams },
    { label: vision.cameraOn ? 'Stop sharing camera' : 'Share camera', onSelect: vision.toggleCamera },
    { label: ttsEnabled ? 'Captions only' : 'Turn voice on', onSelect: () => setTts(!ttsEnabled) },
    null,
    { label: 'Auto-arrange windows', hint: 'O', onSelect: autoArrange },
    { label: 'Clear the screen', hint: 'Esc Esc', onSelect: clearStage },
    { label: 'Ambient mode', onSelect: () => setAmbient(true) },
    { label: 'All commands', hint: 'Ctrl K', onSelect: () => setPaletteOpen(true) },
  ]

  const commands = [
    { label: 'Ask Nandi', hint: '/', onSelect: () => chatInputRef.current?.focus() },
    { label: 'Talk', hint: 'hold Space', onSelect: toggleMic },
    { label: voiceOpen ? 'End voice mode' : 'Voice mode: a live conversation', onSelect: voiceOpen ? closeVoice : openVoice },
    { label: 'Open live audio streams', onSelect: openStreams },
    { label: micShare.on ? 'Stop sharing this microphone' : 'Share this microphone', onSelect: () => toggleMicShare(!micShare.on) },
    { label: 'Open settings', onSelect: () => setSettingsOpen(true) },
    { label: 'Open transcript', hint: 'console', onSelect: () => openConsole('transcript') },
    { label: 'Open logs', hint: 'console', onSelect: () => openConsole('logs') },
    { label: 'Open activity', hint: 'console', onSelect: () => openConsole('activity') },
    { label: 'Open devices', hint: 'console', onSelect: () => openConsole('devices') },
    { label: 'Open files', hint: 'console', onSelect: () => openConsole('files') },
    { label: 'Open scheduled tasks', hint: 'console', onSelect: () => openConsole('tasks') },
    { label: consoleOpen ? 'Close console' : 'Open console', hint: 'Ctrl `', onSelect: () => setConsoleOpen(o => !o) },
    { label: vision.cameraOn ? 'Stop sharing camera' : 'Share camera', onSelect: vision.toggleCamera },
    { label: ttsEnabled ? 'Captions only' : 'Turn voice on', onSelect: () => setTts(!ttsEnabled) },
    { label: 'Auto-arrange windows', hint: 'O', onSelect: autoArrange },
    { label: 'Clear the screen', hint: 'Esc Esc', onSelect: clearStage },
    { label: 'Clear the conversation', hint: 'Ctrl L', onSelect: clearConversation },
    { label: 'Stop what is running', hint: 'Shift Esc', onSelect: stopAllJobs },
    { label: 'Ambient mode', onSelect: () => setAmbient(true) },
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
  keysRef.current = { ambient, paletteOpen, settingsOpen, speaking, clearStage, stopAllJobs, cycleTheme, clearConversation }

  useEffect(() => {
    // Hold Space to talk: key-down starts, key-up (or leaving the window with
    // the key still down) stops and sends.
    const releaseSpace = () => {
      if (!spaceHeldRef.current) return false
      spaceHeldRef.current = false
      chatInputRef.current?.stopMic()
      return true
    }
    const onKeyDown = (e) => {
      const k = keysRef.current
      const mod = e.ctrlKey || e.metaKey
      if (k.ambient) { if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) setAmbient(false); return }
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); return }
      if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); k.clearConversation(); return }
      if (mod && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); setConsoleOpen(o => !o); return }
      if (k.paletteOpen || k.settingsOpen) return

      if (e.key === 'Escape') {
        // Esc while dictating throws the recording away.
        if (micPhaseRef.current === 'recording') { spaceHeldRef.current = false; chatInputRef.current?.cancelMic(); return }
        if (e.shiftKey) { k.stopAllJobs(); return }
        if (k.speaking) { stopTts(); return }
        const now = performance.now()
        if (now - lastEscRef.current < DOUBLE_ESC_MS) { k.clearStage(); lastEscRef.current = 0; return }
        lastEscRef.current = now
        stageRef.current?.closeTop()
        return
      }
      if (isTyping(document.activeElement) || mod || e.altKey) return
      if (e.key === '/') { e.preventDefault(); chatInputRef.current?.focus(); return }
      if (e.key === 'o' || e.key === 'O') { stageRef.current?.autoArrange(); return }
      if (e.key === 't' || e.key === 'T') { k.cycleTheme(); return }
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault()
        if (!voiceOpenRef.current && !spaceHeldRef.current) {
          spaceHeldRef.current = true
          chatInputRef.current?.startMic()
        }
      }
    }
    const onKeyUp = (e) => {
      if (e.code === 'Space' && releaseSpace()) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseSpace)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseSpace)
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

  const showHint = messages.length === 0 && !hasItems && coreState === 'idle' && !voiceOpen
  const voiceBusy = voiceOpen && (voiceState === 'thinking' || voiceState === 'speaking')
  const micNotice = micShare.on && !micShare.busy
    ? { label: 'Mic shared', title: `This device's microphone is being shared as ${micStreamId()}`, onClick: openStreams }
    : null
  const jobStrip = <JobStrip job={runningJob} pending={pending ? pending.progress : null} onStop={handleStopTask} />

  return (
    <div className={`screen${stageMode ? ' screen--stage' : ''}${ambient ? ' screen--ambient' : ''}`}
      onPointerDownCapture={ambient ? () => setAmbient(false) : undefined}>
      <TopBar coreState={coreState} menuItems={menuItems} scheme={scheme} onScheme={setScheme} notice={micNotice} />

      <main className="screen__main" ref={mainRef}>
        <Core state={coreState} mode={coreMode} dockRef={globeRef}
          amplitudeRef={voiceLevelRef} anchorRefs={coreAnchors} onActivate={toggleMic} />

        <Stage ref={stageRef} items={items} renderContent={renderContent} onClose={closeCard}
          onClear={clearStage} narrow={narrow} onArrangedChange={setArranged} />

        <section className="voice" aria-label="Nandi">
          {showHint && (
            <p className="voice__hint" ref={hintRef}>Click the core or hold <kbd>Space</kbd> to talk</p>
          )}
          {/* Under the core while it is in the middle; in the dock otherwise. */}
          {!stageMode && <div className="voice__strip" ref={stripRef}>{jobStrip}</div>}

          <div className="dock" ref={dockRef}>
            <div className="voice__bar">
              {voiceOpen && (
                <Suspense fallback={<div className="voice-mode voice-mode--loading">Starting voice mode…</div>}>
                  <VoiceMode onTurn={handleVoiceTurn} onLevel={handleVoiceLevel} onState={setVoiceState}
                    onCaption={handleVoiceCaption} onClose={closeVoice} />
                </Suspense>
              )}
              {/* Hidden rather than unmounted during voice mode, so a half-typed
                  message and its attachments are still there afterwards. */}
              <div className="voice__input" hidden={voiceOpen}>
                <ChatInput ref={chatInputRef} onSend={handleSend} onMicPhase={setMicPhase} onVoiceMode={openVoice} />
              </div>
            </div>

            {/* Where the core sits while windows are on the stage. */}
            <button className="dock__globe" ref={globeRef} onClick={toggleMic} tabIndex={stageMode ? 0 : -1}
              aria-hidden={!stageMode} aria-label="Talk to Nandi" title="Talk (or hold Space)" />

            <div className="dock__rest">
              <Captions caption={caption} hold={!!pending || speaking || voiceBusy} docked={stageMode && !narrow} />
              {stageMode && (
                <div className="dock__end">
                  {jobStrip}
                  <span className="dock__count">{items.length === 1 ? '1 window' : `${items.length} windows`}</span>
                  {arranged && (
                    <button className="dock__btn" onClick={autoArrange} title="Put every window back in place (O)">Auto-arrange</button>
                  )}
                  <button className="dock__btn" onClick={clearStage} disabled={!hasItems} title="Close every window (Esc Esc)">Clear</button>
                </div>
              )}
            </div>
          </div>
        </section>

        <Toasts toasts={toasts} onDismiss={dismissToast} />
        {ambient && <AmbientClock />}
      </main>

      <Console
        open={consoleOpen} onToggle={() => setConsoleOpen(o => !o)}
        tab={consoleTab} onTab={setConsoleTab}
        messages={messages} activities={activities} onStopActivity={handleStopTask}
        showLogs={showLogs} connected={connected} capDevices={capDevices}
        vision={consoleVision} tasksVersion={tasksVersion}
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
          onOpenAudioStreams={() => { setSettingsOpen(false); setStreamsOpen(true) }}
          ambientDelay={ambientDelay}
          onAmbientDelayChange={changeAmbientDelay}
        />
      )}

      {streamsOpen && (
        <AudioStreamsPanel
          onClose={() => setStreamsOpen(false)}
          onListen={listenToStream}
          micShare={micShare}
          onToggleMicShare={toggleMicShare}
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
