// ═══════════════════════════════════════════════════════════
//  endpoints.js  –  which backend this build talks to
//
//  Running `npm run dev` used to connect the local frontend to PRODUCTION.
//  Both wsAdapter and visionControl listed the production host first and
//  health-checked in order, so as long as api.shuun.site was reachable — which
//  it always is — the local dev build talked to the live server. In testing
//  this session, a local page registered a vision-control client on production
//  and started sending chat frames to it. A dev session could have triggered
//  real home automation or a real WhatsApp message.
//
//  Now the target is explicit and comes from the build mode, with an env
//  override for the cases that need one (previewing a prod build against a
//  local backend, or pointing a dev build at staging).
//
//    VITE_API_BASE=https://api.shuun.site   npm run dev
//    VITE_VISION_SIGNAL_URL=ws://localhost:8765/ws/signal
// ═══════════════════════════════════════════════════════════

const PROD_API = 'https://api.shuun.site'
// 127.0.0.1, not localhost. "localhost" resolves to ::1 first in browsers on
// macOS, and uvicorn's default --host 127.0.0.1 binds IPv4 only — so the page
// silently fails with a 1006 while curl (which prefers IPv4) works fine. Worse,
// if any other process holds the IPv6 wildcard on that port, the browser talks
// to THAT instead. Pinning the family removes the ambiguity.
const DEV_API = 'http://127.0.0.1:8000'

const PROD_VISION_SIGNAL = 'wss://vision.shuun.site/ws/signal'
const DEV_VISION_SIGNAL = 'ws://127.0.0.1:8765/ws/signal'

/** http(s) base for REST calls. */
export const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? DEV_API : PROD_API)

/** ws(s) base, derived from API_BASE so the two can never disagree. */
export const WS_BASE = API_BASE.replace(/^http/, 'ws')

export const CHAT_WS = `${WS_BASE}/ws/chat`
// Not under /ws/ — the brain server mounts this router at /api/vision, and
// nginx's /ws/ location block does not proxy it.
export const VISION_CONTROL_WS = `${WS_BASE}/api/vision/control`
export const LOGS_WS = `${WS_BASE}/ws/logs`
export const HEALTH_URL = `${API_BASE}/health`

/**
 * Vision server signaling URL.
 *
 * The localStorage override is kept — it is documented in VISION_README and is
 * genuinely useful for pointing a browser at a different vision server without
 * a rebuild — but the default now follows the build mode instead of always
 * being production.
 */
export function getVisionSignalUrl() {
  return (
    localStorage.getItem('nandi_vision_signal_url') ||
    import.meta.env.VITE_VISION_SIGNAL_URL ||
    (import.meta.env.DEV ? DEV_VISION_SIGNAL : PROD_VISION_SIGNAL)
  )
}

// Make the target obvious in the console — the whole class of bug above comes
// from not knowing which backend you are actually talking to.
console.info(
  `[nandi] API ${API_BASE} (${import.meta.env.DEV ? 'dev' : 'production'} build)`
)
