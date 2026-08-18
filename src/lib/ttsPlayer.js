// ═══════════════════════════════════════════════════════════
//  ttsPlayer.js  –  Text-to-speech via backend proxy (OpenAI TTS)
// ═══════════════════════════════════════════════════════════

import { getBaseUrl } from './wsAdapter.js'

let currentAudio = null
let isPlaying = false
let volumeCallback = null
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

  const token = getToken()
  const baseUrl = getBaseUrl()

  try {
    const res = await fetch(`${baseUrl}/api/voice/speak`, {
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
    console.error('[tts] failed:', err)
    isPlaying = false
    if (onEnd) onEnd()
  }
}

// ── Stop playback ────────────────────────────────────────

export function stop() {
  isPlaying = false
  cancelAnimationFrame(rafId)
  volumeCallback = null

  if (currentAudio) {
    try { currentAudio.source.stop() } catch {}
    try { currentAudio.context.close() } catch {}
    currentAudio = null
  }
}

export function getIsPlaying() {
  return isPlaying
}
