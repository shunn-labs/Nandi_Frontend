// ═══════════════════════════════════════════════════════════
//  chime.js  –  the sound a notification makes
//
//  Synthesised with Web Audio (no audio file to ship or cache): a soft
//  two-note chime, lower and repeated for errors. On by default; the
//  choice lives in localStorage ('nandi_notification_sound').
//
//  Browsers only let a page make sound after the user has interacted with
//  it once (a click or key press). The audio context is unlocked on the
//  first such interaction, so every notification after that is heard,
//  even while the tab is in the background. A screen nobody has touched
//  since it loaded stays silent until the first click; a kiosk/wall display
//  can lift this with Chrome's --autoplay-policy=no-user-gesture-required.
// ═══════════════════════════════════════════════════════════

const KEY = 'nandi_notification_sound'

let ctx = null

function context() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    ctx = new Ctx()
  }
  return ctx
}

function unlock() {
  const c = context()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, unlock, { capture: true, passive: true })
  }
}

/** The page's shared audio context (unlocked on the first interaction), or null. */
export function audioContext() {
  return context()
}

export function isSoundEnabled() {
  try { return localStorage.getItem(KEY) !== 'false' } catch { return true }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(KEY, on ? 'true' : 'false') } catch { /* private mode */ }
}

function note(c, freq, start, length, peak) {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  osc.connect(gain).connect(c.destination)
  osc.start(start)
  osc.stop(start + length + 0.05)
}

/**
 * Play the notification chime. tone: 'info' (default) | 'alert'.
 * force: play even when the user switched the sound off (the settings preview).
 * Never throws; silently does nothing where audio is unavailable or still locked.
 */
export function playChime(tone = 'info', { force = false } = {}) {
  if (!force && !isSoundEnabled()) return
  try {
    const c = context()
    if (!c) return
    if (c.state === 'suspended') c.resume().catch(() => {})
    const t = c.currentTime + 0.02
    if (tone === 'alert') {
      note(c, 523.25, t, 0.22, 0.18)          // C5
      note(c, 392.0, t + 0.18, 0.3, 0.18)     // G4
      note(c, 523.25, t + 0.5, 0.22, 0.14)
      note(c, 392.0, t + 0.68, 0.35, 0.14)
    } else {
      note(c, 880.0, t, 0.35, 0.16)           // A5
      note(c, 1318.5, t + 0.12, 0.6, 0.12)    // E6
    }
  } catch { /* audio unavailable */ }
}
