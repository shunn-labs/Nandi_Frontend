// ═══════════════════════════════════════════════════════════
//  visionControl.js  –  this browser's display channel to the brain
//
//  Vision agent → brain server → this WebSocket → browser action.
//  The browser identifies itself with a client_id (e.g. web_react_pc).
//
//  The same socket carries everything a capability needs from the user, from
//  any MCP server or brain feature (Brain's manager/interaction.py):
//    prompt / prompt_closed   cards that wait for an answer (Allow / Deny, a form)
//    activity                 a live job card (steps, outcome, Stop)
//    devices / event          what each capability has connected; things that happened
//    ui_snapshot              all of the above when this socket registers
//    notification(s)          a reminder or scheduled-task result; on register,
//                             the unread ones that arrived while away
//    tasks_changed            a scheduled task was created, changed or ran
//  Subscribe with onUiFrame(); answer with sendDisplay().
//
//  Hardened against:
//   - React StrictMode double-mount (duplicate sockets in dev)
//   - stale onclose handlers from superseded sockets rotating the URL
//   - URL rotation when a connection actually succeeded
// ═══════════════════════════════════════════════════════════

// client_id now comes from the shared helper, so the chat socket and this one
// always agree on what to call this browser.
import { getClientId, getDeviceName } from './clientId.js'
import { VISION_CONTROL_WS } from './endpoints.js'


// Close codes meaning "your token is not acceptable". Retrying is pointless.
const FATAL_CLOSE_CODES = new Set([1008, 4401, 4403])
const MAX_RECONNECT_DELAY = 30000

// Keeps an idle socket from being reaped by proxies between vision commands,
// which can be minutes apart.
const PING_INTERVAL_MS = 25000

let ws = null
let connected = false
let commandHandler = null
let reconnectTimer = null
let reconnectAttempt = 0
let stopped = false
let pingTimer = null
// Why the server refused to register us. A refusal stops retrying, so without
// this the column could only show a grey dot and no reason.
let lastError = ''

// Frames for the chat's cards (see the header). `ui_disconnected` is synthesised
// here when the socket drops, so device status never shows stale.
const UI_ACTIONS = new Set([
  'prompt', 'prompt_closed', 'prompt_invalid', 'activity', 'activity_stop_ack',
  'devices', 'event', 'ui_snapshot', 'notification', 'notifications', 'tasks_changed',
  'close_cards',   // "remove this image" — the brain's screen__close tool (ChatView resolves it)
])
const uiListeners = new Set()

function emitUi(frame) {
  for (const cb of uiListeners) {
    try { cb(frame) } catch (err) { console.error('[vision-ctrl] ui listener failed', err) }
  }
}

/** Cards, live activity, device status and events from the brain. Returns unsubscribe. */
export function onUiFrame(cb) {
  uiListeners.add(cb)
  return () => uiListeners.delete(cb)
}

/** Answer a card or stop a job. True if it went out on an open, registered socket. */
export function sendDisplay(frame) {
  if (!ws || !connected || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(frame))
  return true
}

function getToken() {
  return localStorage.getItem('user_token')
}


export function getMyClientId() {
  return getClientId()
}

// ── Set the handler that receives vision commands ──────────
export function onVisionCommand(handler) {
  commandHandler = handler
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function startPing(sock) {
  stopPing()
  pingTimer = setInterval(() => {
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) return
    sock.send(JSON.stringify({ type: 'ping' }))
  }, PING_INTERVAL_MS)
}

function scheduleReconnect() {
  if (reconnectTimer || stopped) return
  reconnectAttempt += 1
  const base = Math.min(1000 * 2 ** (reconnectAttempt - 1), MAX_RECONNECT_DELAY)
  const delay = Math.round(base * (0.7 + Math.random() * 0.6))
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

// ── Connect with auto-retry on alternate URLs ──────────────
function connect() {
  // Already connecting or open? Don't open a second socket.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const url = VISION_CONTROL_WS
  const clientId = getClientId()
  const token = getToken()

  if (!token) {
    console.warn('[vision-ctrl] no token — not connecting')
    stopped = true
    return
  }

  console.log(`[vision-ctrl] connecting → ${url} as ${clientId}`)

  let sock
  try {
    sock = new WebSocket(url)
  } catch (err) {
    console.error('[vision-ctrl] WebSocket creation failed:', err)
    scheduleReconnect()
    return
  }
  ws = sock

  sock.onopen = () => {
    if (ws !== sock) return   // superseded
    console.log('[vision-ctrl] connected, registering…')
    // device_name lets the server push vision results to the device a query
    // came from without having to parse it back out of client_id.
    sock.send(JSON.stringify({
      type: 'register',
      client_id: clientId,
      device_name: getDeviceName(),
      token,
    }))
  }

  sock.onmessage = (event) => {
    if (ws !== sock) return   // ignore messages from an old socket
    let msg
    try { msg = JSON.parse(event.data) } catch { return }

    if (msg.type === 'registered') {
      connected = true
      reconnectAttempt = 0
      lastError = ''
      startPing(sock)
      console.log(`[vision-ctrl] registered as ${msg.client_id}`)
      return
    }

    if (msg.type === 'pong') return

    // Current servers send {type:'error', error} and then close with 4401;
    // older ones send a bare {error}. Either way it is a refusal.
    if (msg.type === 'error' || msg.error) {
      // The server now rejects bad tokens and client_ids owned by someone
      // else. Neither is fixable by reconnecting, so stop instead of looping.
      lastError = msg.error || msg.message || 'registration refused'
      console.warn('[vision-ctrl] registration refused:', lastError)
      stopped = true
      connected = false
      stopPing()
      return
    }

    if (msg.action && UI_ACTIONS.has(msg.action)) {
      emitUi(msg)
      return
    }

    // Forward display commands to handler
    //   { action: 'show_frame',  image_b64, mime, label, wid, request_id, camera, file_id }
    //   { action: 'show_stream', stream_id, label, wid, request_id }
    //   { action: 'show_file',   file: {file_id, filename, mime, size, kind, ...}, url, label, wid }
    //   { action: 'play_audio',  url, mime, label, wid, duration_s, autoplay, request_id }
    //   { action: 'show_audio_stream', stream_id, label, wid, request_id }
    //   { action: 'close',       wid }
    //   { action: 'close_all' }
    if (msg.action && commandHandler) {
      commandHandler(msg)
    }
  }

  sock.onerror = () => {
    // Don't log the noisy Event object; onclose handles retry.
  }

  sock.onclose = (event) => {
    if (ws !== sock) return   // a newer socket already took over — ignore
    connected = false
    stopPing()
    emitUi({ action: 'ui_disconnected' })
    if (FATAL_CLOSE_CODES.has(event.code)) {
      console.warn(`[vision-ctrl] rejected (${event.code}) — not retrying`)
      stopped = true
      // Keep the error frame's text if there was one; otherwise say something.
      if (!lastError) lastError = event.reason || `rejected by server (${event.code})`
      return
    }
    if (stopped) return
    console.warn(`[vision-ctrl] closed (${event.code}), will retry`)
    scheduleReconnect()
  }
}

// ── Public ─────────────────────────────────────────────────
export function startVisionControl() {
  // Idempotent: if a socket is already live or connecting, do nothing.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return
  }
  // A fresh start — e.g. after logout and a new login — must undo the stop
  // left by disconnect() or by a refusal, or nothing would ever connect again.
  stopped = false
  reconnectAttempt = 0
  connect()
}

export function isVisionControlConnected() {
  return connected
}

/** Why the server refused this browser's registration, or '' if it has not. */
export function getVisionControlError() {
  return lastError
}

export function disconnect() {
  stopped = true
  stopPing()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    const sock = ws
    ws = null            // mark superseded so handlers no-op
    try { sock.close() } catch {}
  }
  connected = false
  emitUi({ action: 'ui_disconnected' })
}
