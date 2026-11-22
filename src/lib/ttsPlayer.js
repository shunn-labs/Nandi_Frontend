// ═══════════════════════════════════════════════════════════
//  ttsPlayer.js  –  Text-to-speech from the Nandi Audio Server, streamed
//
//  POST {AUDIO_BASE}/v1/tts {text, format:"pcm", markdown:true} answers with
//  raw PCM16LE mono as the server synthesises it, sentence by sentence
//  (X-Sample-Rate says the rate, 24000). Each chunk is scheduled through
//  WebAudio the moment it arrives, back to back, so Nandi starts talking on
//  the first sentence instead of after the whole reply has been rendered —
//  the old /api/tts returned one mp3 that had to arrive in full and be
//  decoded first. The AnalyserNode every chunk passes through keeps feeding
//  the core's speaking animation.
// ═══════════════════════════════════════════════════════════

import { AUDIO_BASE } from './endpoints.js'
import { audioNetworkError, audioResponseError, authHeaders } from './audioApi.js'
import { splitEmotionTag } from './emotionTag.js'

const DEFAULT_RATE = 24000
// Network reads arrive in whatever sizes TCP delivers. Tiny buffers mean many
// nodes and audible seams, so samples are gathered into ~100 ms buffers
// (the first one is sent sooner, to get going).
const FIRST_CHUNK_SAMPLES = 1200     // 50 ms at 24 kHz
const CHUNK_SAMPLES = 2400           // 100 ms
// Headroom before the first buffer plays, and the least lead any later buffer
// is given when the stream has fallen behind (a pause rather than a click).
const START_LEAD_S = 0.08
const MIN_LEAD_S = 0.02

const TTS_MESSAGES = {
  400: 'Nothing to say.',
  503: 'Text-to-speech is unavailable right now.',
}

let playback = null        // the current utterance (see speak)
let isPlaying = false

// ── Monitor output volume (feeds the core) ───────────────

function monitorPlaybackVolume(p) {
  if (playback !== p || !p.analyser) return

  const data = p.levelData
  p.analyser.getByteTimeDomainData(data)

  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / data.length)

  p.onVolume?.(rms)
  p.rafId = requestAnimationFrame(() => monitorPlaybackVolume(p))
}

// ── PCM16LE → AudioBuffer scheduling ─────────────────────

function schedule(p, samples) {
  const { ctx } = p
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768

  const buffer = ctx.createBuffer(1, floats.length, p.rate)   // resampled to the context rate by WebAudio
  buffer.copyToChannel(floats, 0)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(p.analyser)

  const startAt = Math.max(p.playHead, ctx.currentTime + (p.sources.size ? MIN_LEAD_S : START_LEAD_S))
  source.start(startAt)
  p.playHead = startAt + buffer.duration

  p.sources.add(source)
  source.onended = () => {
    p.sources.delete(source)
    if (p.streamDone && p.sources.size === 0) finish(p)
  }
}

/** Turns arbitrary byte chunks into whole little-endian 16-bit samples. */
function pcmAssembler() {
  let carry = null          // a byte left over from an odd-length chunk
  return (bytes) => {
    let data = bytes
    if (carry !== null) {
      data = new Uint8Array(bytes.length + 1)
      data[0] = carry
      data.set(bytes, 1)
      carry = null
    }
    if (data.length % 2) {
      carry = data[data.length - 1]
      data = data.subarray(0, data.length - 1)
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const out = new Int16Array(data.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true)
    return out
  }
}

function closeContext(ctx) {
  try { ctx?.close?.()?.catch?.(() => {}) } catch {}
}

function finish(p) {
  if (playback !== p) return
  playback = null
  isPlaying = false
  cancelAnimationFrame(p.rafId)
  p.onVolume?.(0)
  closeContext(p.ctx)
  p.onEnd?.()
}

// ── Speak text ───────────────────────────────────────────

/**
 * Speak `text` (markdown is fine — the server strips it; a leading emotion
 * tag is sent as the `emotion` field, never read out). Resolves when the
 * last chunk has been scheduled; `onEnd` runs exactly once: when playback is
 * over, has failed, or was cut off by stop() (or by the next speak()), so a
 * caller tracking "is Nandi speaking" hears about an interruption too.
 */
export async function speak(text, onVolume, onEnd) {
  stop() // stop any current playback

  const { emotion, text: words } = splitEmotionTag(text)
  const body = { text: words.trim(), format: 'pcm', markdown: true }
  if (emotion) body.emotion = emotion

  const p = {
    abort: new AbortController(),
    ctx: null,
    analyser: null,
    levelData: null,
    sources: new Set(),
    playHead: 0,
    rate: DEFAULT_RATE,
    streamDone: false,
    rafId: null,
    onVolume: onVolume || null,
    onEnd: onEnd || null,
  }
  playback = p

  if (!body.text) {
    finish(p)
    return
  }

  try {
    let res
    try {
      res = await fetch(`${AUDIO_BASE}/v1/tts`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: p.abort.signal,
      })
    } catch (err) {
      throw err?.name === 'AbortError' ? err : audioNetworkError(err, 'the speech server')
    }
    if (!res.ok) throw await audioResponseError(res, TTS_MESSAGES, `Text-to-speech failed (HTTP ${res.status}).`)
    if (playback !== p) return

    p.rate = parseInt(res.headers.get('X-Sample-Rate'), 10) || DEFAULT_RATE
    console.debug(`[tts] streaming ${p.rate} Hz from ${res.headers.get('X-Engine') || 'unknown'} engine`)

    // Created only once there is audio to play, as before — an AudioContext
    // made without a recent user gesture may start suspended; resume() is
    // harmless when it is not.
    p.ctx = new (window.AudioContext || window.webkitAudioContext)()
    p.ctx.resume?.().catch(() => {})
    p.analyser = p.ctx.createAnalyser()
    p.analyser.fftSize = 2048
    p.levelData = new Uint8Array(p.analyser.fftSize)
    p.analyser.connect(p.ctx.destination)

    isPlaying = true
    monitorPlaybackVolume(p)

    const toSamples = pcmAssembler()
    let pending = []
    let pendingLength = 0
    const flush = () => {
      if (!pendingLength) return
      const merged = new Int16Array(pendingLength)
      let offset = 0
      for (const part of pending) { merged.set(part, offset); offset += part.length }
      pending = []
      pendingLength = 0
      schedule(p, merged)
    }

    if (res.body?.getReader) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (playback !== p) return
        if (done) break
        const samples = toSamples(value)
        if (!samples.length) continue
        pending.push(samples)
        pendingLength += samples.length
        if (pendingLength >= (p.sources.size ? CHUNK_SAMPLES : FIRST_CHUNK_SAMPLES)) flush()
      }
    } else {
      // No streaming body (very old browsers): play it once it has all arrived.
      const samples = toSamples(new Uint8Array(await res.arrayBuffer()))
      if (playback !== p) return
      pending.push(samples)
      pendingLength += samples.length
    }
    flush()

    p.streamDone = true
    if (p.sources.size === 0) finish(p)
  } catch (err) {
    if (err?.name === 'AbortError' || playback !== p) return
    console.error('[tts] failed:', err?.userMessage || err)
    finish(p)
  }
}

// ── Stop playback ────────────────────────────────────────

export function stop() {
  const p = playback
  playback = null
  isPlaying = false
  if (!p) return

  p.abort.abort()
  cancelAnimationFrame(p.rafId)
  for (const source of p.sources) {
    source.onended = null
    try { source.stop() } catch {}
  }
  p.sources.clear()
  closeContext(p.ctx)
  // Let the core settle instead of freezing on the last level it was given.
  p.onVolume?.(0)
  p.onEnd?.()
}

export function getIsPlaying() {
  return isPlaying
}
