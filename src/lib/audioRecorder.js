// ═══════════════════════════════════════════════════════════
//  audioRecorder.js  –  Record + energy-based VAD + STT via backend proxy
// ═══════════════════════════════════════════════════════════

import { getBaseUrl } from './wsAdapter.js'

const SILENCE_THRESHOLD = 0.015    // RMS below this = silence
const SILENCE_DURATION  = 1600     // ms of silence before auto-stop
const MIN_RECORD_TIME   = 600      // ms minimum recording length

let mediaStream    = null
let mediaRecorder  = null
let audioContext   = null
let analyser       = null
let chunks         = []
let silenceTimer   = null
let recordStart    = 0
let volumeCallback = null          // for orb animation
let rafId          = null

function getToken() {
  return localStorage.getItem('user_token')
}

// ── Volume monitoring (feeds orb) ────────────────────────

function monitorVolume() {
  if (!analyser) return
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)

  // Compute RMS
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / data.length)

  if (volumeCallback) volumeCallback(rms)

  // Silence detection
  if (rms < SILENCE_THRESHOLD) {
    if (!silenceTimer) {
      silenceTimer = setTimeout(() => {
        if (Date.now() - recordStart > MIN_RECORD_TIME && mediaRecorder?.state === 'recording') {
          stopRecording()
        }
      }, SILENCE_DURATION)
    }
  } else {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }

  rafId = requestAnimationFrame(monitorVolume)
}

// ── Start recording ──────────────────────────────────────

let resolveRecording = null

export function startRecording(onVolume) {
  volumeCallback = onVolume || null

  return new Promise(async (resolve, reject) => {
    resolveRecording = resolve

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // Web Audio for analysis
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioContext.createMediaStreamSource(mediaStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)

      // MediaRecorder for actual capture
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType })
      chunks = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        cleanup()
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType })
        chunks = []

        if (blob.size < 1000) {
          // Too short / empty
          resolveRecording?.('')
          return
        }

        try {
          const text = await transcribe(blob)
          resolveRecording?.(text)
        } catch (err) {
          console.error('[stt] transcription failed:', err)
          resolveRecording?.('')
        }
      }

      mediaRecorder.start(250) // collect in 250ms chunks
      recordStart = Date.now()
      monitorVolume()

    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}

// ── Stop recording ───────────────────────────────────────

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
  }
}

export function isRecording() {
  return mediaRecorder?.state === 'recording'
}

// ── Cleanup ──────────────────────────────────────────────

function cleanup() {
  cancelAnimationFrame(rafId)
  clearTimeout(silenceTimer)
  silenceTimer = null
  volumeCallback = null

  if (audioContext) {
    audioContext.close().catch(() => {})
    audioContext = null
    analyser = null
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
}

// ── Transcribe via backend proxy ─────────────────────────
// Your FastAPI backend needs a POST /api/stt endpoint
// that forwards the audio to OpenAI Whisper and returns { text }

async function transcribe(blob) {
  const token = getToken()
  const baseUrl = getBaseUrl()

  const form = new FormData()
  form.append('audio', blob, 'recording.webm')

  const res = await fetch(`${baseUrl}/api/voice/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })

  if (!res.ok) throw new Error(`STT failed: ${res.status}`)

  const data = await res.json()
  return data.text || ''
}
