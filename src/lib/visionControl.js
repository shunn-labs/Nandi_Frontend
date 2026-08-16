// ═══════════════════════════════════════════════════════════
//  visionControl.js  –  WebSocket to brain server for vision commands
//
//  Vision agent → brain server → this WebSocket → browser action.
//  The browser identifies itself with a client_id (e.g. web_react_pc).
//
//  Hardened against:
//   - React StrictMode double-mount (duplicate sockets in dev)
//   - stale onclose handlers from superseded sockets rotating the URL
//   - URL rotation when a connection actually succeeded
// ═══════════════════════════════════════════════════════════

// client_id now comes from the shared helper, so the chat socket and this one
// always agree on what to call this browser.
import { getClientId } from './clientId.js'
import { VISION_CONTROL_WS } from './endpoints.js'


// Close codes meaning "your token is not acceptable". Retrying is pointless.
const FATAL_CLOSE_CODES = new Set([1008, 4401, 4403])
const MAX_RECONNECT_DELAY = 30000

let ws = null
let connected = false
let commandHandler = null
let reconnectTimer = null
let reconnectAttempt = 0
let stopped = false

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
    sock.send(JSON.stringify({
      type: 'register',
      client_id: clientId,
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
      console.log(`[vision-ctrl] registered as ${msg.client_id}`)
      return
    }

    if (msg.error) {
      // The server now rejects bad tokens and client_ids owned by someone
      // else. Neither is fixable by reconnecting, so stop instead of looping.
      console.warn('[vision-ctrl] registration refused:', msg.error)
      stopped = true
      return
    }

    // Forward vision commands to handler
    //   { action: 'show_frame',  image_b64, label, wid }
    //   { action: 'show_stream', stream_id, label, wid }
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
    if (FATAL_CLOSE_CODES.has(event.code)) {
      console.warn(`[vision-ctrl] rejected (${event.code}) — not retrying`)
      stopped = true
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
  stopped = false
  reconnectAttempt = 0
  connect()
}

export function isVisionControlConnected() {
  return connected
}

export function disconnect() {
  stopped = true
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
}
