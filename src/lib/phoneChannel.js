// ═══════════════════════════════════════════════════════════
//  phoneChannel.js  –  the line to the user's phones
//
//  One WebSocket to the android server's /ui channel (not through Brain):
//  approvals and questions a phone needs answered, the live steps of a
//  running phone task, phone events (missed call, new message, low battery)
//  and which devices are online. Authenticated with the same login token the
//  Brain chat uses. Protocol: nandi-android-app docs/protocol.md.
//
//    onPhoneFrame(cb)   every frame from the server → unsubscribe()
//    onPhoneStatus(cb)  { connected, devices }       → unsubscribe()
//    sendPhone(frame)   approval_answer / question_answer / stop
//    closePhoneChannel() on logout: closes and stops reconnecting
// ═══════════════════════════════════════════════════════════

import { ANDROID_UI_WS } from './endpoints.js'

const PING_MS = 25000
const MAX_BACKOFF_MS = 30000
const AUTH_RETRY_MS = 60000        // after a rejected login (close 4401)
const CLOSE_UNAUTHORIZED = 4401

let ws = null
let wanted = false                 // false after closePhoneChannel(): never reconnect
let backoff = 1000
let retryTimer = null
let pingTimer = null
let status = { connected: false, devices: [] }
const frameListeners = new Set()
const statusListeners = new Set()

function setStatus(next) {
  status = { ...status, ...next }
  for (const cb of statusListeners) cb(status)
}

function schedule(ms) {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(connect, ms)
}

function connect() {
  if (!wanted || ws) return
  const token = localStorage.getItem('user_token')
  if (!token) { schedule(AUTH_RETRY_MS); return }

  let socket
  try {
    socket = new WebSocket(ANDROID_UI_WS)
  } catch {
    schedule(backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    return
  }
  ws = socket
  let authed = false

  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }))

  socket.onmessage = (event) => {
    let frame
    try { frame = JSON.parse(event.data) } catch { return }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'ready') {
      authed = true
      backoff = 1000
      clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
      }, PING_MS)
      setStatus({ connected: true, devices: Array.isArray(frame.devices) ? frame.devices : [] })
    } else if (frame.type === 'devices') {
      setStatus({ devices: Array.isArray(frame.devices) ? frame.devices : [] })
    } else if (frame.type === 'pong') {
      return
    }
    for (const cb of frameListeners) {
      try { cb(frame) } catch (e) { console.error('[phone] listener failed', e) }
    }
  }

  socket.onclose = (event) => {
    if (ws === socket) ws = null
    clearInterval(pingTimer)
    setStatus({ connected: false, devices: [] })
    if (!wanted) return
    if (event.code === CLOSE_UNAUTHORIZED) {
      // A bad or expired login, or the server has no NANDI_JWT_SECRET: retrying
      // every second would change nothing.
      console.warn('[phone] android server refused this login:', event.reason || event.code)
      schedule(AUTH_RETRY_MS)
      return
    }
    schedule(authed ? 1000 : backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  socket.onerror = () => { /* onclose follows */ }
}

function start() {
  if (wanted) return
  wanted = true
  backoff = 1000
  connect()
}

export function onPhoneFrame(cb) {
  frameListeners.add(cb)
  start()
  return () => frameListeners.delete(cb)
}

export function onPhoneStatus(cb) {
  statusListeners.add(cb)
  cb(status)
  start()
  return () => statusListeners.delete(cb)
}

/** True if the frame was handed to an open socket. */
export function sendPhone(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(frame))
  return true
}

export function closePhoneChannel() {
  wanted = false
  clearTimeout(retryTimer)
  clearInterval(pingTimer)
  const socket = ws
  ws = null
  if (socket) {
    try { socket.close(1000) } catch { /* already closed */ }
  }
  setStatus({ connected: false, devices: [] })
}
