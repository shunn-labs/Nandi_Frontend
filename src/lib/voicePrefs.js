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
