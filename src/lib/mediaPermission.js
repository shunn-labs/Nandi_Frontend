// ═══════════════════════════════════════════════════════════
//  mediaPermission.js  –  microphone / camera permission, remembered
//
//  A web page can't grant itself permission; the browser decides, per ORIGIN
//  (scheme + host + port). It remembers a "yes" across restarts and days only
//  when the user picks the persistent option:
//    Chrome / Edge   "Allow while visiting the site"   (not "Allow this time")
//    Firefox         tick "Remember this decision"
//    Safari          Settings for this website ▸ Microphone/Camera ▸ Allow
//  …until site data is cleared or the browser is reset. (A dev server that
//  moves to another port is another origin: vite.config.js pins 5173.)
//
//  So this module only:
//    * reads the live state (Permissions API) to skip needless requests,
//    * remembers in localStorage that a grant happened, so when a later visit
//      finds the browser asking again we can explain how to make it stick,
//    * offers one "allow now" request for mic + camera from Settings.
// ═══════════════════════════════════════════════════════════

const GRANTED_KEY = 'nandi_media_granted'      // { microphone: iso-date, camera: iso-date }
const HINTED_KEY = 'nandi_media_hinted'        // the "it forgot" hint was shown this visit

function readGrants() {
  try { return JSON.parse(localStorage.getItem(GRANTED_KEY) || '{}') || {} } catch { return {} }
}

function rememberGrant(name) {
  try {
    const g = readGrants()
    if (!g[name]) {
      g[name] = new Date().toISOString()
      localStorage.setItem(GRANTED_KEY, JSON.stringify(g))
    }
  } catch { /* storage unavailable */ }
}

/** 'granted' | 'denied' | 'prompt' | 'unknown' (no Permissions API for it here). */
export async function permissionState(name) {
  try {
    const status = await navigator.permissions?.query?.({ name })
    return status?.state || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Calls cb(state) whenever the browser's permission for `name` changes. Returns an unsubscribe. */
export function watchPermission(name, cb) {
  let status = null
  let stopped = false
  const onChange = () => cb(status.state)
  navigator.permissions?.query?.({ name }).then((s) => {
    if (stopped) return
    status = s
    cb(s.state)
    s.addEventListener?.('change', onChange)
  }).catch(() => cb('unknown'))
  return () => {
    stopped = true
    status?.removeEventListener?.('change', onChange)
  }
}

/** Start remembering grants (call once at startup). */
export function initPermissionMemory() {
  for (const name of ['microphone', 'camera']) {
    watchPermission(name, (state) => { if (state === 'granted') rememberGrant(name) })
  }
}

/** The browser is about to ask again although the user allowed it before (it forgot). */
export async function permissionWasForgotten(name) {
  if (!readGrants()[name]) return false
  return (await permissionState(name)) === 'prompt'
}

/** How to make the browser remember, in this browser's words. */
export function persistHint(kind = 'microphone') {
  const ua = navigator.userAgent || ''
  const what = kind === 'camera' ? 'camera' : 'microphone'
  if (/Firefox\//.test(ua)) return `Tip: tick “Remember this decision” when Firefox asks, so Nandi can use the ${what} without asking every time.`
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) {
    return `Tip: in Safari ▸ Settings for this website, set ${what === 'camera' ? 'Camera' : 'Microphone'} to “Allow” so it isn't asked every time.`
  }
  return `Tip: choose “Allow while visiting the site” (not “Allow this time”) so the browser remembers the ${what} for Nandi.`
}

/**
 * A one-time-per-visit hint when the browser forgot an earlier "yes" (one-time
 * grant, cleared data). Returns the text, or '' when there is nothing to say.
 */
export async function forgottenPermissionHint(name = 'microphone') {
  try {
    if (sessionStorage.getItem(HINTED_KEY)) return ''
    if (!(await permissionWasForgotten(name))) return ''
    sessionStorage.setItem(HINTED_KEY, '1')
  } catch {
    return ''
  }
  return persistHint(name)
}

/**
 * Ask for microphone (and camera) access once, e.g. from Settings, so later
 * features don't stop to ask. Returns { mic, camera } as permission states.
 */
export async function requestMediaAccess({ audio = true, video = true } = {}) {
  const result = {}
  const ask = async (constraints, name) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      s.getTracks().forEach(t => t.stop())
      rememberGrant(name)
      result[name] = 'granted'
    } catch (err) {
      result[name] = err?.name === 'NotAllowedError' ? 'denied' : 'unavailable'
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) return { microphone: 'unavailable', camera: 'unavailable' }
  if (audio) await ask({ audio: true }, 'microphone')
  if (video) await ask({ video: true }, 'camera')
  return result
}
