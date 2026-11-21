// ═══════════════════════════════════════════════════════════
//  audioRecorder.js  –  Record + energy-based VAD + STT on the audio server
// ═══════════════════════════════════════════════════════════

import { AUDIO_BASE } from './endpoints.js'
import { audioNetworkError, audioResponseError, authHeaders } from './audioApi.js'
import { getVoiceLang } from './voicePrefs.js'

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

// The audio server decodes any container itself, so take the first one this
// browser can record. Safari has no webm recorder at all — with webm as the
// only choice, dictation threw there before a word was said.
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  return RECORDING_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || ''
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
let rejectRecording = null

export function startRecording(onVolume) {
  volumeCallback = onVolume || null

  return new Promise(async (resolve, reject) => {
    resolveRecording = resolve
    rejectRecording = reject

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // Web Audio for analysis
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioContext.createMediaStreamSource(mediaStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)

      // MediaRecorder for actual capture
      const mimeType = pickMimeType()

      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
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
          // Was `resolve('')`, which is the same value used for "you didn't
          // say anything". A failing STT endpoint was therefore indis-
          // tinguishable from silence: the mic stopped and nothing happened,
          // with the reason only in the console. Reject so the caller can say
          // so.
          console.error('[stt] transcription failed:', err)
          rejectRecording?.(err)
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

// ── Transcribe on the Nandi Audio Server ─────────────────
// POST {AUDIO_BASE}/v1/stt, multipart field `file` (any format: the server
// decodes webm/opus, ogg, mp4… itself) plus the voice language from Settings
// → { text, language, engine, duration }. The brain's old /api/stt is gone.
//
// Failures throw an Error whose `userMessage` is a sentence ChatInput can show
// as is — "the session expired" and "the speech service is down" need
// different things from the user, and a bare "STT failed: 401" said neither.

const STT_MESSAGES = {
  401: 'Your session has expired — sign in again to use the microphone.',
  413: 'That recording is too long to transcribe.',
  400: 'The recording could not be decoded. Try again.',
  503: 'Speech recognition is unavailable right now. Try again in a moment.',
}

function recordingName(type) {
  if (/ogg/.test(type)) return 'recording.ogg'
  if (/mp4|aac|m4a/.test(type)) return 'recording.m4a'
  return 'recording.webm'
}

export async function transcribe(blob) {
  if (!localStorage.getItem('user_token')) {
    throw Object.assign(new Error('Not signed in'), { userMessage: 'Sign in to use the microphone.' })
  }

  const form = new FormData()
  form.append('file', blob, recordingName(blob.type))
  form.append('language', getVoiceLang())

  let res
  try {
    res = await fetch(`${AUDIO_BASE}/v1/stt`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
  } catch (err) {
    throw audioNetworkError(err, 'the speech server')
  }

  if (!res.ok) {
    throw await audioResponseError(res, STT_MESSAGES, `Speech-to-text failed (HTTP ${res.status}).`)
  }

  const data = await res.json()
  return typeof data.text === 'string' ? data.text.trim() : ''
}
