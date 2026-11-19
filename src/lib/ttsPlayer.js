// ═══════════════════════════════════════════════════════════
//  ttsPlayer.js  –  Text-to-speech via backend proxy (OpenAI TTS)
//
//  Server voice needs an OpenAI key. When the brain answers 501 (no TTS
//  provider) or the request fails, fall back to the browser's built-in
//  speechSynthesis. A 501 is remembered for the session so we don't ask again
//  for every message.
// ═══════════════════════════════════════════════════════════

import { getBaseUrl } from './wsAdapter.js'

let currentAudio = null
let isPlaying = false
let volumeCallback = null
let audioContext = null
let analyser = null
let rafId = null
let serverTtsUnavailable = false
let browserUtterance = null

// ── Browser speech fallback ──────────────────────────────

function speakWithBrowser(text, onEnd) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
  if (!synth || !text) {
    if (onEnd) onEnd()
    return
  }
  try {
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    browserUtterance = u
    isPlaying = true
    // No audio graph to analyse; give the orb a gentle pulse instead.
    let t = 0
    const pulse = () => {
      if (!isPlaying || browserUtterance !== u) return
      t += 1
      if (volumeCallback) volumeCallback(0.08 + 0.06 * Math.abs(Math.sin(t / 6)))
      rafId = requestAnimationFrame(pulse)
    }
    const done = () => {
      if (browserUtterance !== u) return
      browserUtterance = null
      isPlaying = false
      cancelAnimationFrame(rafId)
      if (volumeCallback) volumeCallback(0)
      volumeCallback = null
      if (onEnd) onEnd()
    }
    u.onend = done
    u.onerror = done
    synth.speak(u)
    pulse()
  } catch (err) {
    console.error('[tts] browser speech failed:', err)
    isPlaying = false
    if (onEnd) onEnd()
  }
}

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

  if (serverTtsUnavailable) {
    speakWithBrowser(text, onEnd)
    return
  }

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

    if (res.status === 501) {
      serverTtsUnavailable = true
      console.info('[tts] server voice not configured; using browser speech')
      speakWithBrowser(text, onEnd)
      return
    }
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`)

    const arrayBuffer = await res.arrayBuffer()

    // Use Web Audio API for playback + volume analysis
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

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
      if (onEnd) onEnd()
    }

    currentAudio = { source, context: audioContext }
  } catch (err) {
    console.error('[tts] failed, using browser speech:', err)
    isPlaying = false
    speakWithBrowser(text, onEnd)
  }
}

// ── Stop playback ────────────────────────────────────────

export function stop() {
  isPlaying = false
  cancelAnimationFrame(rafId)
  volumeCallback = null

  if (browserUtterance) {
    browserUtterance = null
    try { window.speechSynthesis?.cancel() } catch {}
  }

  if (currentAudio) {
    try { currentAudio.source.stop() } catch {}
    try { currentAudio.context.close() } catch {}
    currentAudio = null
  }
}

export function getIsPlaying() {
  return isPlaying
}
