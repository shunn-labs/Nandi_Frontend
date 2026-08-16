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

const VISION_CTRL_URLS = [
  'wss://api.shuun.site/ws/vision-control',
  'ws://localhost:8000/ws/vision-control',
]

let ws = null
let connected = false
let everConnected = false        // did we ever successfully register?
let commandHandler = null
let activeUrlIndex = 0
let reconnectTimer = null

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
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 4000)
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

  const url = VISION_CTRL_URLS[activeUrlIndex]
  const clientId = getClientId()
  const token = getToken()

  console.log(`[vision-ctrl] connecting → ${url} as ${clientId}`)

  let sock
  try {
    sock = new WebSocket(url)
  } catch (err) {
    console.error('[vision-ctrl] WebSocket creation failed:', err)
    activeUrlIndex = (activeUrlIndex + 1) % VISION_CTRL_URLS.length
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
      everConnected = true
      console.log(`[vision-ctrl] registered as ${msg.client_id}`)
      return
    }

    if (msg.error) {
      console.warn('[vision-ctrl] error:', msg.error)
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

  sock.onclose = () => {
    if (ws !== sock) return   // a newer socket already took over — ignore
    connected = false
    console.warn('[vision-ctrl] closed, will retry')
    // Only rotate to the alternate URL if we never managed to connect on this
    // one. Once we've connected successfully, keep using the working URL.
    if (!everConnected) {
      activeUrlIndex = (activeUrlIndex + 1) % VISION_CTRL_URLS.length
    }
    scheduleReconnect()
  }
}

// ── Public ─────────────────────────────────────────────────
export function startVisionControl() {
  // Idempotent: if a socket is already live or connecting, do nothing.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return
  }
  connect()
}

export function isVisionControlConnected() {
  return connected
}

export function disconnect() {
  if (ws) {
    const sock = ws
    ws = null            // mark superseded so handlers no-op
    try { sock.close() } catch {}
  }
  connected = false
}
