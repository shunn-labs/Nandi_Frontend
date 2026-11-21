// ═══════════════════════════════════════════════════════════
//  ttsPlayer.js  –  Text-to-speech via backend proxy (OpenAI TTS)
// ═══════════════════════════════════════════════════════════

import { getBaseUrl } from './wsAdapter.js'

let currentAudio = null
let isPlaying = false
let volumeCallback = null
// The current utterance's onEnd. stop() calls it too, so a caller tracking
// "is Nandi speaking" hears about an interruption, not only a natural end.
let endCallback = null
// Bumped by every speak() and stop(). A fetch that finishes after the user
// cut Nandi off sees a newer generation and stays silent.
let generation = 0
let audioContext = null
let analyser = null
let rafId = null

function getToken() {
  return localStorage.getItem('user_token')
}

// ── Monitor output volume (feeds orb) ────────────────────

function monitorPlaybackVolume() {
  if (!analyser) return

  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)

  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / data.length)

  if (volumeCallback) volumeCallback(rms)

  if (isPlaying) {
    rafId = requestAnimationFrame(monitorPlaybackVolume)
  }
}

// ── Speak text ───────────────────────────────────────────
// Backend needs POST /api/tts  body: { text }  → returns audio/mpeg

export async function speak(text, onVolume, onEnd) {
  stop() // stop any current playback

  volumeCallback = onVolume || null
  endCallback = onEnd || null
  const gen = ++generation

  const token = getToken()
  const baseUrl = getBaseUrl()

  try {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text }),
    })

    if (!res.ok) throw new Error(`TTS failed: ${res.status}`)

    const arrayBuffer = await res.arrayBuffer()

    // Use Web Audio API for playback + volume analysis
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    if (gen !== generation) { try { ctx.close() } catch {} ; return }
    audioContext = ctx

    const source = audioContext.createBufferSource()
    source.buffer = audioBuffer

    analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048

    source.connect(analyser)
    analyser.connect(audioContext.destination)

    isPlaying = true
    source.start(0)
    monitorPlaybackVolume()

    source.onended = () => {
      isPlaying = false
      cancelAnimationFrame(rafId)
      volumeCallback = null
      finish()
    }

    currentAudio = { source, context: audioContext }
  } catch (err) {
    console.error('[tts] failed:', err)
    isPlaying = false
    finish()
  }
}

function finish() {
  const cb = endCallback
  endCallback = null
  if (cb) cb()
}

// ── Stop playback ────────────────────────────────────────

export function stop() {
  generation++
  isPlaying = false
  cancelAnimationFrame(rafId)
  volumeCallback = null

  if (currentAudio) {
    // Detach first, so the stopped source's onended doesn't run finish() for
    // whatever is spoken next.
    currentAudio.source.onended = null
    try { currentAudio.source.stop() } catch {}
    try { currentAudio.context.close() } catch {}
    currentAudio = null
  }
  finish()
}

export function getIsPlaying() {
  return isPlaying
}
