// ═══════════════════════════════════════════════════════════
//  endpoints.js  –  which backend this build talks to
//
//  Running `npm run dev` used to connect the local frontend to PRODUCTION.
//  Both wsAdapter and visionControl listed the production host first and
//  health-checked in order, so as long as the production host was reachable — which
//  it always is — the local dev build talked to the live server. In testing
//  this session, a local page registered a vision-control client on production
//  and started sending chat frames to it. A dev session could have triggered
//  real home automation or a real WhatsApp message.
//
//  Now the target is explicit and comes from the build mode, with an env
//  override for the cases that need one (previewing a prod build against a
//  local backend, or pointing a dev build at staging).
//
//    VITE_API_BASE=https://brain.shunnlabs.in   npm run dev
//    VITE_VISION_SIGNAL_URL=ws://localhost:8765/ws/signal
//    VITE_AUDIO_BASE=https://dev-audio.shunnlabs.in
// ═══════════════════════════════════════════════════════════

// Brain serves the app's chat and display traffic over one origin:
// /auth/google-login, /api/upload, and the /ws/{chat,vision-control,logs}
// sockets. Speech is no longer the brain's: speech-to-text, text-to-speech,
// voice conversation and live audio streams all live on the Nandi Audio Server
// (AUDIO_BASE below) — the brain's old /api/stt and /api/tts are gone.
// auth.shunnlabs.in is a separate, newer service this frontend does not use.
const PROD_API = 'https://brain.shunnlabs.in'
// 127.0.0.1, not localhost. "localhost" resolves to ::1 first in browsers on
// macOS, and uvicorn's default --host 127.0.0.1 binds IPv4 only — so the page
// silently fails with a 1006 while curl (which prefers IPv4) works fine. Worse,
// if any other process holds the IPv6 wildcard on that port, the browser talks
// to THAT instead. Pinning the family removes the ambiguity.
const DEV_API = 'http://127.0.0.1:8000'

const PROD_VISION_SIGNAL = 'wss://vision.shunnlabs.in/ws/signal'
const DEV_VISION_SIGNAL = 'ws://127.0.0.1:8765/ws/signal'

// Staging is https://dev-audio.shunnlabs.in — reach it with VITE_AUDIO_BASE or
// the Settings override, never by default.
const PROD_AUDIO = 'https://audio.shunnlabs.in'
const DEV_AUDIO = 'http://127.0.0.1:8200'
const AUDIO_OVERRIDE_KEY = 'nandi_audio_base'

/** http(s) base for REST calls. */
export const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? DEV_API : PROD_API)

/** ws(s) base, derived from API_BASE so the two can never disagree. */
export const WS_BASE = API_BASE.replace(/^http/, 'ws')

export const CHAT_WS = `${WS_BASE}/ws/chat`
export const VISION_CONTROL_WS = `${WS_BASE}/ws/vision-control`
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

/** http(s) base of the vision server's REST API, from the signaling URL. */
export function getVisionApiBase() {
  return getVisionSignalUrl().replace(/^ws/, 'http').replace(/\/ws\/signal\/?$/, '')
}

// ── Nandi Audio Server ──────────────────────────────────────
// STT (/v1/stt), TTS (/v1/tts), voice conversation over WebRTC (/v1/voice/offer)
// and live audio streams (/v1/streams). Every endpoint takes the brain JWT the
// app already holds, as `Authorization: Bearer …`.

/** An http(s) origin + path without a trailing slash, or '' if `value` is not one. */
export function normalizeHttpBase(value) {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** The build's audio server, ignoring any Settings override. */
export const DEFAULT_AUDIO_BASE =
  normalizeHttpBase(import.meta.env.VITE_AUDIO_BASE) ||
  (import.meta.env.DEV ? DEV_AUDIO : PROD_AUDIO)

// Read at module load, so it must not throw: with site data blocked even
// touching localStorage can, and that would stop the app from starting.
function storedOverride() {
  try { return normalizeHttpBase(localStorage.getItem(AUDIO_OVERRIDE_KEY)) } catch { return '' }
}

function resolveAudioBase() {
  // Same precedence as the vision signal URL: a per-browser override from
  // Settings, then the build's env, then the build mode's default. A malformed
  // override is ignored rather than breaking every speech request.
  return storedOverride() || DEFAULT_AUDIO_BASE
}

// `let`, and re-assigned by setAudioBaseOverride(): ES module exports are live
// bindings, so every module that reads AUDIO_BASE at call time picks up a new
// override from Settings without a page reload.
export let AUDIO_BASE = resolveAudioBase()
export let AUDIO_OFFER_URL = `${AUDIO_BASE}/v1/voice/offer`

/** The override stored in this browser ('' when there is none). */
export function getAudioBaseOverride() {
  return storedOverride()
}

/**
 * Point this browser at another audio server ('' goes back to the default).
 * Returns the base now in use. Throws on anything that is not an http(s) URL.
 */
export function setAudioBaseOverride(value) {
  const raw = (value || '').trim()
  const base = normalizeHttpBase(raw)
  if (raw && !base) throw new Error('Enter a full http:// or https:// address.')
  if (base && base !== DEFAULT_AUDIO_BASE) localStorage.setItem(AUDIO_OVERRIDE_KEY, base)
  else localStorage.removeItem(AUDIO_OVERRIDE_KEY)
  AUDIO_BASE = resolveAudioBase()
  AUDIO_OFFER_URL = `${AUDIO_BASE}/v1/voice/offer`
  console.info(`[nandi] audio server → ${AUDIO_BASE}`)
  return AUDIO_BASE
}

// Make the target obvious in the console — the whole class of bug above comes
// from not knowing which backend you are actually talking to.
console.info(
  `[nandi] API ${API_BASE} · audio ${AUDIO_BASE} (${import.meta.env.DEV ? 'dev' : 'production'} build)`
)
