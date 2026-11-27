// ═══════════════════════════════════════════════════════════
//  voicePrefs.js  –  voice settings kept in this browser
//
//  Read at the moment they are needed (a new voice session, a dictation), so
//  a change in Settings applies to the next one without any shared state.
// ═══════════════════════════════════════════════════════════

const LANG_KEY = 'nandi_voice_lang'
const DUPLEX_KEY = 'nandi_voice_duplex'

export const VOICE_LANGUAGES = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
]

/** 'auto' | 'en' | 'hi' — the language the audio server listens for. */
export function getVoiceLang() {
  const v = localStorage.getItem(LANG_KEY)
  return VOICE_LANGUAGES.some(l => l.value === v) ? v : 'auto'
}

export function setVoiceLang(value) {
  localStorage.setItem(LANG_KEY, VOICE_LANGUAGES.some(l => l.value === value) ? value : 'auto')
}

/**
 * 'full' — barge-in: speaking while Nandi talks interrupts her (needs the
 *          browser's echo cancellation, which is on by default).
 * 'half' — the mic is ignored while Nandi talks; for speakers loud enough to
 *          leak back into the mic and interrupt her with her own voice.
 */
export function getVoiceDuplex() {
  return localStorage.getItem(DUPLEX_KEY) === 'half' ? 'half' : 'full'
}

export function setVoiceDuplex(value) {
  localStorage.setItem(DUPLEX_KEY, value === 'half' ? 'half' : 'full')
}

// ── wake word ("hey Nandi"), like the Raspberry Pi client ─────────────

/** Dispatched on window (by the globe) to wake voice mode, as if "hey Nandi" was said. */
export const VOICE_WAKE_EVENT = 'nandi:voice-wake'

const WAKE_KEY = 'nandi_voice_wake'
const WAKE_SENS_KEY = 'nandi_voice_wake_sensitivity'
const FOLLOWUP_KEY = 'nandi_voice_followup_s'
const BEEPS_KEY = 'nandi_voice_beeps'

/**
 * On (default): voice mode sleeps until "hey Nandi" / "hi Nandi" (or a tap),
 * listens for one request, then keeps a short follow-up window open.
 * Off: the mic is always open to Nandi while voice mode is on (the old way).
 */
export function getWakeEnabled() {
  return localStorage.getItem(WAKE_KEY) !== 'off'
}

export function setWakeEnabled(on) {
  localStorage.setItem(WAKE_KEY, on ? 'on' : 'off')
}

/**
 * How easily "hey Nandi" wakes voice mode. The model's own threshold (0.99, from
 * its offline evaluation) is a little strict for browser audio, which reaches the
 * model resampled and processed: measured in Chrome on the owner's real recordings,
 * 0.95 heard 18 of 21 takes vs 16 at 0.99, with no false wake in 3 min of real
 * room audio. So 0.95 is the default here; `null` = use the model's .json value.
 */
export const WAKE_SENSITIVITIES = [
  { value: 'strict', label: 'Strict (fewest false wakes)', threshold: null },
  { value: 'normal', label: 'Normal', threshold: 0.95 },
  { value: 'high', label: 'Sensitive', threshold: 0.9 },
]

export function getWakeSensitivity() {
  const v = localStorage.getItem(WAKE_SENS_KEY)
  return WAKE_SENSITIVITIES.some(s => s.value === v) ? v : 'normal'
}

export function setWakeSensitivity(value) {
  localStorage.setItem(WAKE_SENS_KEY, WAKE_SENSITIVITIES.some(s => s.value === value) ? value : 'normal')
}

export function getWakeThreshold() {
  return WAKE_SENSITIVITIES.find(s => s.value === getWakeSensitivity())?.threshold ?? null
}

export const FOLLOWUP_CHOICES = [0, 8, 15, 30]

/** Seconds after a reply during which you can just keep talking (0 = sleep right away). */
export function getFollowupSeconds() {
  const n = Number(localStorage.getItem(FOLLOWUP_KEY))
  return FOLLOWUP_CHOICES.includes(n) && localStorage.getItem(FOLLOWUP_KEY) !== null ? n : 15
}

export function setFollowupSeconds(value) {
  const n = Number(value)
  localStorage.setItem(FOLLOWUP_KEY, String(FOLLOWUP_CHOICES.includes(n) ? n : 15))
}

/** Wake / sleep beeps on (default) or off. */
export function getBeepsEnabled() {
  return localStorage.getItem(BEEPS_KEY) !== 'off'
}

export function setBeepsEnabled(on) {
  localStorage.setItem(BEEPS_KEY, on ? 'on' : 'off')
}
