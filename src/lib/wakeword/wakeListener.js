// ═══════════════════════════════════════════════════════════
//  wakeListener.js  –  "hey Nandi" / "hi Nandi" detection in the browser
//
//  openWakeWord running on onnxruntime-web (WASM, one thread: no special
//  COOP/COEP headers needed). The pipeline is the one parity-tested against
//  the Python package in shunn-labs/Nandi_WakeWord (oww.js + worklet.js are
//  verbatim copies of integration/web/ there):
//
//    mic track ─► AudioWorklet (16 kHz, 1280-sample / 80 ms chunks)
//              ─► melspectrogram.onnx ─► embedding_model.onnx ─► hey_nandi.onnx ─► score
//
//  The model, its settings (threshold / patience / debounce from the .json)
//  and the two shared feature models are static files under
//  public/wakeword/<model-version>/. Everything here is loaded lazily, with
//  voice mode, so the main bundle doesn't carry onnxruntime.
//
//  The listener reads a CLONE of the voice session's mic track: one capture,
//  no second permission prompt, and the clone keeps delivering audio while
//  the session's own track is muted towards the server.
// ═══════════════════════════════════════════════════════════

import { WakeWordDetector } from './oww.js'
import workletUrl from './worklet.js?url'
// onnxruntime-web doesn't export its WASM build files; imported by path so
// Vite serves/emits them from our own origin (no CDN at runtime).
import ortWasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import ortMjsUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'

/** Folder (under public/) of the wake-word model in use; the name carries its version. */
export const WAKE_MODEL_DIR = `${import.meta.env.BASE_URL}wakeword/hey_nandi-2026-11-26/`

// Faint dither (±3 LSB of 16-bit audio): exact digital silence makes the
// log-mel front end misbehave and can produce false wakes (Pi client finding).
const DITHER = 3 / 32768
// If the models fall this many 80 ms chunks behind (a slow device), drop audio
// rather than build an ever-growing delay.
const MAX_BACKLOG = 6

let ortPromise = null
function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/wasm').then((ort) => {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl }
      return ort
    })
  }
  return ortPromise
}

let metaPromise = null
/** The model's own settings (threshold, patience, debounce_s), from its .json. */
export function loadWakeModelMeta() {
  if (!metaPromise) {
    metaPromise = fetch(`${WAKE_MODEL_DIR}hey_nandi.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
  }
  return metaPromise
}

export class WakeListener {
  /**
   * handlers: onWake(score) when the wake word is heard; onScore(score) for every
   * 80 ms frame (debug readouts). options.threshold overrides the model's own.
   */
  constructor({ onWake, onScore } = {}, { threshold = null } = {}) {
    this.onWake = onWake
    this.onScore = onScore
    this.thresholdOverride = threshold
    this.detector = null
    this.ctx = null
    this.node = null
    this.source = null
    this.sink = null
    this.track = null
    this.paused = false
    this.backlog = 0
    this.queue = Promise.resolve()
    this.disposed = false
    this.lastScore = 0
    this.threshold = null
  }

  /** Load onnxruntime + the models. Safe to call more than once. */
  async init() {
    if (this.detector) return this
    const [ort, meta] = await Promise.all([loadOrt(), loadWakeModelMeta()])
    const threshold = Number(this.thresholdOverride) || Number(meta.threshold) || 0.99
    this.threshold = threshold
    const detector = new WakeWordDetector(ort, {
      melspec: `${WAKE_MODEL_DIR}melspectrogram.onnx`,
      embedding: `${WAKE_MODEL_DIR}embedding_model.onnx`,
      model: `${WAKE_MODEL_DIR}hey_nandi.onnx`,
      threshold,
      patience: Number(meta.patience) || 1,
      debounceMs: (Number(meta.debounce_s) || 1.5) * 1000,
    })
    await detector.init()
    if (this.disposed) return this
    this.detector = detector
    return this
  }

  /** Start listening to (a clone of) a live mic track. Replaces any earlier track. */
  async attach(track) {
    await this.init()
    this.detach()
    if (this.disposed || !track || track.readyState === 'ended') return
    const own = track.clone()
    this.track = own
    const AC = window.AudioContext || window.webkitAudioContext
    const stream = new MediaStream([own])
    // A 16 kHz context lets the browser resample (best quality). Some browsers
    // refuse a mic source at a different rate: then run at the device rate and
    // let the worklet downsample.
    let ctx = null
    let source = null
    try {
      ctx = new AC({ sampleRate: 16000 })
      source = ctx.createMediaStreamSource(stream)
    } catch {
      try { ctx?.close?.() } catch {}
      ctx = new AC()
      source = ctx.createMediaStreamSource(stream)
    }
    this.ctx = ctx
    this.source = source
    await ctx.audioWorklet.addModule(workletUrl)
    if (this.ctx !== ctx) return          // detached while loading
    this.node = new AudioWorkletNode(ctx, 'pcm-capture')
    // A worklet node that leads nowhere may never be pulled: route it into a
    // silent gain so the graph renders.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.node.port.onmessage = (ev) => this._chunk(ev.data)
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination)
    ctx.resume?.().catch(() => {})
    this.detector.reset()
  }

  /** Stop listening to the current track (the models stay loaded). */
  detach() {
    try { this.source?.disconnect() } catch {}
    try { this.node?.disconnect() } catch {}
    if (this.node) this.node.port.onmessage = null
    try { this.track?.stop() } catch {}
    const ctx = this.ctx
    this.ctx = this.node = this.source = this.sink = this.track = null
    try { ctx?.close?.()?.catch?.(() => {}) } catch {}
  }

  /** Ignore audio until resume() (cheap: the graph keeps running). */
  pause() { this.paused = true }

  /** Listen again with fresh buffers, so nothing heard before counts. */
  resume() {
    if (!this.paused) return
    this.paused = false
    this.detector?.reset()
  }

  get listening() { return !!this.ctx && !this.paused }

  dispose() {
    this.disposed = true
    this.detach()
  }

  _chunk(samples) {
    if (this.paused || !this.detector || this.backlog >= MAX_BACKLOG) return
    for (let i = 0; i < samples.length; i++) samples[i] += (Math.random() * 2 - 1) * DITHER
    this.backlog++
    this.queue = this.queue.then(async () => {
      try {
        if (this.paused || !this.detector) return
        for (const r of await this.detector.process(samples)) {
          this.lastScore = r.score
          this.onScore?.(r.score)
          if (r.wake && !this.paused) this.onWake?.(r.score)
        }
      } catch (err) {
        console.warn('[wake] detector error:', err)
      } finally {
        this.backlog--
      }
    })
  }
}
