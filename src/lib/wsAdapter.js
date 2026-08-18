// ═══════════════════════════════════════════════════════════
//  wsAdapter.js  –  WebSocket chat + REST upload for Nandi
// ═══════════════════════════════════════════════════════════

// Shared with visionControl.js so both sockets identify this browser the same
// way — see src/lib/clientId.js for why that matters to the planner.
import { getClientId } from './clientId.js'
import { API_BASE, CHAT_WS, HEALTH_URL } from './endpoints.js'

// Close codes the server uses to reject a connection outright. Reconnecting
// after one of these is pointless — the token will still be invalid — and the
// old code did exactly that, producing an endless 4-second reconnect storm
// against the server for any user whose token had expired.
const FATAL_CLOSE_CODES = new Set([1008, 4401, 4403])

const MAX_RECONNECT_DELAY = 30000

let ws = null
let isConnected = false
let pendingQueue = []
let messageCallback = null
let connectionCallback = null
let authFailureCallback = null
let reconnectAttempt = 0
let stopped = false

// ── Helpers ───────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('user_token')
}

export async function isServerHealthy() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

export function getBaseUrl() {
  return API_BASE
}

/**
 * API base for callers that run before any socket exists (i.e. Login).
 *
 * The login page used to hardcode https://api.shuun.site, so signing in
 * against a local backend was impossible.
 */
export async function getApiBaseUrl() {
  return API_BASE
}

/** Called when the server rejects our token, so the UI can send the user to login. */
export function onAuthFailure(cb) {
  authFailureCallback = cb
}

export function getConnectionState() {
  return isConnected
}

// ── Connection ────────────────────────────────────────────

export function onConnectionChange(cb) {
  connectionCallback = cb
}

export function onMessage(cb) {
  messageCallback = cb
}

function setConnected(val) {
  isConnected = val
  if (connectionCallback) connectionCallback(val)
}

function handleAuthFailure(reason) {
  console.warn(`[ws] authentication rejected: ${reason}`)
  stopped = true                       // do not reconnect — the token is bad
  setConnected(false)
  pendingQueue = []                    // never replay queued messages post-logout
  if (authFailureCallback) authFailureCallback(reason)
}

function connectWS() {
  if (ws) {
    try { ws.close() } catch {}
    ws = null
    setConnected(false)
  }

  const token = getToken()
  if (!token) {
    handleAuthFailure('no token stored')
    return
  }

  console.log(`[ws] connecting → ${CHAT_WS}`)
  ws = new WebSocket(CHAT_WS)
  const sock = ws

  sock.onopen = () => {
    if (ws !== sock) return
    console.log('[ws] connected')
    sock.send(JSON.stringify({ type: 'auth', token }))

    // Flush queued messages after brief auth delay
    setTimeout(() => {
      if (ws !== sock || sock.readyState !== WebSocket.OPEN) return
      for (const item of pendingQueue) sock.send(JSON.stringify(item))
      pendingQueue = []
    }, 120)
  }

  sock.onmessage = (event) => {
    if (ws !== sock) return
    let data
    try { data = JSON.parse(event.data) } catch { return }

    if (data.type === 'authenticated') {
      console.log('[ws] authenticated')
      reconnectAttempt = 0             // a real success resets the backoff
      setConnected(true)
      return
    }

    // Turn-level errors arrive as {type: 'error', code, message} and do not
    // close the socket — the server keeps the connection open so one bad turn
    // doesn't force a reconnect. Only an auth-code error means the token
    // itself is bad; other codes (invalid_request, internal_error, ...) are
    // just forwarded to the UI below.
    if (data.type === 'error') {
      if (data.code === 'unauthenticated' || data.code === 'forbidden') {
        handleAuthFailure(data.message)
        try { sock.close() } catch {}
        return
      }
      if (messageCallback) {
        messageCallback({ ...data, response_text: '', error: data.message })
      }
      return
    }

    const responseText = data.response || data.conversation_output || ''
    if (messageCallback) messageCallback({ ...data, response_text: responseText })
  }

  sock.onerror = () => {
    if (ws === sock) setConnected(false)
  }

  sock.onclose = (event) => {
    if (ws !== sock) return
    setConnected(false)

    // The server closes with 1008 when it rejects the auth frame. Retrying
    // cannot succeed, and the old unconditional 4s retry meant one expired
    // token produced an indefinite reconnect storm against the server.
    if (FATAL_CLOSE_CODES.has(event.code)) {
      handleAuthFailure(`server closed with ${event.code}`)
      return
    }
    if (stopped) return

    // Exponential backoff with jitter, rather than a fixed 4s hammer.
    reconnectAttempt += 1
    const base = Math.min(1000 * 2 ** (reconnectAttempt - 1), MAX_RECONNECT_DELAY)
    const delay = Math.round(base * (0.7 + Math.random() * 0.6))
    console.log(`[ws] closed (${event.code}), reconnecting in ${(delay / 1000).toFixed(1)}s`)
    setTimeout(() => ensureConnection(), delay)
  }
}

export async function ensureConnection() {
  if (stopped) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  connectWS()
}

/** Clear the stop flag after a fresh login so the socket can come back up. */
export function resetConnection() {
  stopped = false
  reconnectAttempt = 0
}

// ── Send a chat message ──────────────────────────────────

export function sendMessage(text, attachments = []) {
  const payload = {
    query: text,
    client_id: getClientId(),
    attachments,
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  } else {
    pendingQueue.push(payload)
    ensureConnection()
  }
}

// ── Upload a file ────────────────────────────────────────

export async function uploadFile(file) {
  const token = getToken()
  if (!token) throw new Error('Not authenticated')

  const baseUrl = API_BASE
  const form = new FormData()
  form.append('file', file)

  const res = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText)
    throw new Error(`Upload failed (${res.status}): ${msg}`)
  }

  const json = await res.json()
  return {
    file_id: json.file_id,
    filename: json.filename,
    content_type: json.content_type,
    file_size_bytes: json.size_bytes,
  }
}

// ── Disconnect ───────────────────────────────────────────

export function disconnect() {
  stopped = true
  if (ws) {
    const sock = ws
    ws = null                 // mark superseded so handlers no-op
    try { sock.close() } catch {}
  }
  pendingQueue = []
  setConnected(false)
}