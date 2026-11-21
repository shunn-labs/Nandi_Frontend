// ═══════════════════════════════════════════════════════════
//  emotionTag.js  –  the "[calm] " a voice reply may start with
//
//  In voice mode the brain opens a reply with an emotion tag that tells the
//  text-to-speech voice how to say it ("[cheerful] Good morning!"). It steers
//  the voice and is never meant to be read, so every place that shows
//  assistant text strips it — and speak() sends it as the `emotion` field
//  instead of as words. Same tag list as the audio server (audio/text.py).
// ═══════════════════════════════════════════════════════════

const EMOTION_TAG =
  /^\s*\[\s*(cheerful|excited|calm|sad|serious|whisper|laughing|warm|neutral|apologetic)\s*\]\s*/i

/** '[calm] Sure.' → { emotion: 'calm', text: 'Sure.' }; no tag → { emotion: null, text }. */
export function splitEmotionTag(text) {
  const s = typeof text === 'string' ? text : ''
  const m = EMOTION_TAG.exec(s)
  return m ? { emotion: m[1].toLowerCase(), text: s.slice(m[0].length) } : { emotion: null, text: s }
}

/** The text without a single leading emotion tag. Anything else is left as is. */
export function stripEmotionTag(text) {
  return splitEmotionTag(text).text
}
