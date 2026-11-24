// ═══════════════════════════════════════════════════════════
//  audioRecorder.js  –  Record (press to start, press to stop) + STT on the audio server
// ═══════════════════════════════════════════════════════════
//
// There is no silence detection any more: a pause to think used to end the
// recording mid-sentence (1.6 s of quiet, even before the first word). The
// user decides when they are done — the mic button again, or letting go of
// Space. A long safety cap still ends a recording someone forgot about.

import { AUDIO_BASE } from './endpoints.js'
import { audioNetworkError, audioResponseError, authHeaders } from './audioApi.js'
import { getVoiceLang } from './voicePrefs.js'

export const MAX_RECORD_MS = 10 * 60 * 1000   // a forgotten mic stops after 10 minutes

let mediaStream    = null
let mediaRecorder  = null
let audioContext   = null
let analyser       = null
let chunks         = []
let volumeCallback = null          // the mic level, for the bar's dotted wave
let rafId          = null
let maxTimer       = null
// A stop (or cancel) that arrived while the microphone was still opening.
// Without it, a quick tap of Space — down and up before getUserMedia resolved —
// was lost, and with no silence detection that recording would never end.
let opening        = false
let pendingStop    = false
let cancelled      = false

// The audio server decodes any container itself, so take the first one this
// browser can record. Safari has no webm recorder at all — with webm as the
// only choice, dictation threw there before a word was said.
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  return RECORDING_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || ''
}

// ── Level monitoring (feeds the dotted wave) ─────────────

function monitorVolume() {
  if (!analyser) return
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  if (volumeCallback) volumeCallback(Math.sqrt(sum / data.length))
  rafId = requestAnimationFrame(monitorVolume)
}

// ── Start recording ──────────────────────────────────────

let resolveRecording = null
let rejectRecording = null

/**
 * Records until stopRecording() (then transcribes) or cancelRecording() (then
 * resolves ''). Resolves with the transcript, '' when nothing was said.
 *
 *   onVolume(rms)   the mic level, many times a second
 *   options.onStop  called when the recording has stopped and transcription
 *                   starts (not on cancel)
 *   options.maxMs   safety cap (default 10 minutes)
 */
export function startRecording(onVolume, { onStop, maxMs = MAX_RECORD_MS } = {}) {
  volumeCallback = onVolume || null
  opening = true
  pendingStop = false
  cancelled = false

  return new Promise(async (resolve, reject) => {
    resolveRecording = resolve
    rejectRecording = reject

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      opening = false
      if (pendingStop) {
        // Released before the mic was even open: nothing was said.
        cleanup()
        resolve('')
        return
      }

      // Web Audio for the level
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
        const type = mediaRecorder?.mimeType || mimeType
        cleanup()
        const blob = new Blob(chunks, { type })
        chunks = []

        if (cancelled || blob.size < 1000) {
          // Cancelled, or too short to hold a word.
          resolveRecording?.('')
          return
        }

        onStop?.()
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
      maxTimer = setTimeout(stopRecording, maxMs)
      monitorVolume()

    } catch (err) {
      opening = false
      cleanup()
      reject(err)
    }
  })
}

// ── Stop / cancel ────────────────────────────────────────

/** Stop and transcribe. Safe to call while the mic is still opening. */
export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
  else if (opening) pendingStop = true
}

/** Stop and throw the recording away (Esc). */
export function cancelRecording() {
  cancelled = true
  stopRecording()
}

export function isRecording() {
  return mediaRecorder?.state === 'recording'
}

// ── Cleanup ──────────────────────────────────────────────

function cleanup() {
  cancelAnimationFrame(rafId)
  clearTimeout(maxTimer)
  maxTimer = null
  volumeCallback = null
  mediaRecorder = null

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
