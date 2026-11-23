// Small per-device screen preferences, kept in localStorage. Every access is
// guarded: storage can be missing or throw (private windows, blocked site
// data), and the screen must still work with the defaults.

const AMBIENT_KEY = 'nandi_ambient_after'
const AMBIENT_DEFAULT = 60

/** How long the screen waits, idle, before ambient mode. 0 = never. */
export const AMBIENT_CHOICES = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 0, label: 'Never' },
]

export function getAmbientDelay() {
  try {
    const raw = localStorage.getItem(AMBIENT_KEY)
    if (raw === null) return AMBIENT_DEFAULT
    const n = Number(raw)
    return AMBIENT_CHOICES.some(c => c.value === n) ? n : AMBIENT_DEFAULT
  } catch {
    return AMBIENT_DEFAULT
  }
}

export function setAmbientDelay(seconds) {
  const n = AMBIENT_CHOICES.some(c => c.value === Number(seconds)) ? Number(seconds) : AMBIENT_DEFAULT
  try { localStorage.setItem(AMBIENT_KEY, String(n)) } catch { /* kept for this session only */ }
  return n
}
