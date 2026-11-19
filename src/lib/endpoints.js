// ═══════════════════════════════════════════════════════════
//  endpoints.js  –  which backend this page talks to
//
//  One build runs anywhere. In order of precedence:
//
//   1. window.__NANDI_CONFIG__ from /config.js. The Nandi gateway writes it at
//      runtime, so the same image works on localhost, a LAN IP or a domain.
//   2. VITE_* build-time env (handy for `npm run dev` against a remote brain).
//   3. Defaults:
//        dev build   → http://127.0.0.1:8000 and ws://127.0.0.1:8765/ws/signal
//        prod build  → the page's own origin, with the vision server
//                      behind the gateway at /vision/ws/signal
//
//  Dev builds never default to a production server. A dev page that silently
//  talks to a live brain can trigger real actions (home automation, WhatsApp).
//
//    VITE_API_BASE=https://nandi.example.com          npm run dev
//    VITE_VISION_SIGNAL_URL=ws://localhost:8765/ws/signal
// ═══════════════════════════════════════════════════════════

const RUNTIME = (typeof window !== 'undefined' && window.__NANDI_CONFIG__) || {}

const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '')

// 127.0.0.1, not localhost. "localhost" resolves to ::1 first in browsers on
// macOS, and uvicorn's default --host 127.0.0.1 binds IPv4 only — so the page
// silently fails with a 1006 while curl (which prefers IPv4) works fine.
const DEV_API = 'http://127.0.0.1:8000'
const DEV_VISION_SIGNAL = 'ws://127.0.0.1:8765/ws/signal'

function sameOriginVisionSignal() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/vision/ws/signal`
}

/** http(s) base for REST calls. */
export const API_BASE =
  clean(RUNTIME.apiBase) ||
  clean(import.meta.env.VITE_API_BASE) ||
  (import.meta.env.DEV ? DEV_API : window.location.origin)

/** ws(s) base, derived from API_BASE so the two can never disagree. */
export const WS_BASE = API_BASE.replace(/^http/, 'ws')

export const CHAT_WS = `${WS_BASE}/ws/chat`
export const VISION_CONTROL_WS = `${WS_BASE}/ws/vision-control`
export const LOGS_WS = `${WS_BASE}/ws/logs`
export const HEALTH_URL = `${API_BASE}/health`

/** Google OAuth client id, if this install has one (otherwise local login only). */
export const GOOGLE_CLIENT_ID =
  (RUNTIME.googleClientId || '').trim() ||
  (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim()

export const PRODUCT_NAME = (RUNTIME.productName || '').trim() || 'Nandi AI'

function parseIce(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v
    } catch {
      console.warn('[nandi] ignoring invalid ICE server JSON')
    }
  }
  return null
}

/** WebRTC ICE servers (STUN/TURN). Add a TURN server for cameras outside the LAN. */
export const ICE_SERVERS =
  (parseIce(RUNTIME.iceServers)?.length && parseIce(RUNTIME.iceServers)) ||
  parseIce(import.meta.env.VITE_ICE_SERVERS) || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]

/**
 * Vision server signaling URL. The localStorage override is for pointing one
 * browser at a different vision server without a rebuild.
 */
export function getVisionSignalUrl() {
  return (
    localStorage.getItem('nandi_vision_signal_url') ||
    clean(RUNTIME.visionSignalUrl) ||
    import.meta.env.VITE_VISION_SIGNAL_URL ||
    (import.meta.env.DEV ? DEV_VISION_SIGNAL : sameOriginVisionSignal())
  )
}

// Make the target obvious in the console.
console.info(
  `[nandi] API ${API_BASE} (${import.meta.env.DEV ? 'dev' : 'production'} build)`
)
