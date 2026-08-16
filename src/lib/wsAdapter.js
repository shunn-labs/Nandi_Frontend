// ═══════════════════════════════════════════════════════════
//  wsAdapter.js  –  WebSocket chat + REST upload for Nandi
// ═══════════════════════════════════════════════════════════

// Shared with visionControl.js so both sockets identify this browser the same
// way — see src/lib/clientId.js for why that matters to the planner.
import { getClientId } from './clientId.js'

const SERVERS = [
  'wss://api.shuun.site/ws/chat',
  'ws://localhost:8000/ws/chat',
]

const HEALTH_URLS = [
  'https://api.shuun.site/health',
  'http://localhost:8000/health',
]

const BASE_URLS = [
  'https://api.shuun.site',
  'http://localhost:8000',
]


let ws = null
let isConnected = false
let pendingQueue = []
let activeServerIndex = 0
let messageCallback = null
let connectionCallback = null

// ── Helpers ───────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('user_token')
}

async function pickHealthyServer() {
  for (let i = 0; i < HEALTH_URLS.length; i++) {
    try {
      const res = await fetch(HEALTH_URLS[i], { signal: AbortSignal.timeout(3000) })
      if (res.ok) return i
    } catch { /* skip */ }
  }
  return 0
}

export function getBaseUrl() {
  return BASE_URLS[activeServerIndex]
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

function connectWS(serverIndex) {
  if (ws) {
    try { ws.close() } catch {}
    ws = null
    setConnected(false)
  }

  const url = SERVERS[serverIndex]
  console.log(`[ws] connecting → ${url}`)
  ws = new WebSocket(url)

  ws.onopen = () => {
    activeServerIndex = serverIndex
    console.log(`[ws] connected`)

    const token = getToken()
    if (token) {
      ws.send(JSON.stringify({ type: 'auth', token }))
    }

    // Flush queued messages after brief auth delay
    setTimeout(() => {
      for (const item of pendingQueue) ws.send(JSON.stringify(item))
      pendingQueue = []
    }, 120)
  }

  ws.onmessage = (event) => {
    let data
    try { data = JSON.parse(event.data) } catch { return }

    if (data.status === 'authenticated') {
      console.log('[ws] authenticated')
      setConnected(true)
      return
    }

    if (data.error === 'Invalid or expired token' || data.error === 'Not authenticated') {
      console.warn('[ws] token issue, re-sending auth')
      const token = getToken()
      if (token) ws.send(JSON.stringify({ type: 'auth', token }))
      return
    }

    // Normalise response field
    const responseText = data.response || data.conversation_output || ''
    const normalised = { ...data, response_text: responseText }

    if (messageCallback) messageCallback(normalised)
  }

  ws.onerror = () => setConnected(false)

  ws.onclose = () => {
    setConnected(false)
    console.log('[ws] closed, reconnecting in 4s')
    setTimeout(() => ensureConnection(), 4000)
  }
}

export async function ensureConnection() {
  if (ws && ws.readyState === WebSocket.OPEN) return
  const idx = await pickHealthyServer()
  connectWS(idx)
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

  if (!isConnected) {
    const idx = await pickHealthyServer()
    activeServerIndex = idx
  }

  const baseUrl = BASE_URLS[activeServerIndex]
  const form = new FormData()
  form.append('file', file)

  const res = await fetch(`${baseUrl}/api/upload`, {
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
  }
}

// ── Disconnect ───────────────────────────────────────────

export function disconnect() {
  if (ws) {
    try { ws.close() } catch {}
    ws = null
  }
  setConnected(false)
}