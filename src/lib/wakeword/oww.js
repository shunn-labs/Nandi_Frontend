// openWakeWord streaming detector for JavaScript (browser via onnxruntime-web, Node via onnxruntime-node).
//
// Mirrors openwakeword/utils.py AudioFeatures._streaming_features + Model.predict exactly:
//   every 1280 new samples (80 ms @ 16 kHz):
//     melspectrogram.onnx  on the last 1280+480 samples (int16 values as float32) -> 8 frames x 32 bins
//     mel = mel / 10 + 2   (openWakeWord's transform), appended to a mel buffer that starts as 76 rows of 1.0
//     embedding_model.onnx on the last 76 mel frames ([1,76,32,1]) -> 96-dim embedding
//     wake model           on the last 16 embeddings ([1,16,96])   -> score 0..1
// Like openwakeword.Model, the embedding buffer is seeded with embeddings of 4 s of random noise and
// scores for the first 5 frames after reset() are reported as 0.
//
// Usage:
//   import { WakeWordDetector } from './oww.js';
//   const det = new WakeWordDetector(ort, { melspec, embedding, model, threshold: 0.5, patience: 2 });
//   await det.init();                      // melspec/embedding/model: URL, path or ArrayBuffer/Uint8Array
//   const { score, wake } = await det.process(int16Chunk1280);

export const CHUNK = 1280;
const MEL_CONTEXT = 480;          // 3 x 160-sample hops of left context
const MEL_WINDOW = 76;            // mel frames per embedding
const EMB_FRAMES = 16;            // embeddings per wake-model input
const RAW_MAX = 16000 * 10;
const MEL_MAX = 10 * 97;
const FEAT_MAX = 120;

export class WakeWordDetector {
  constructor(ort, opts) {
    this.ort = ort;
    this.opts = { threshold: 0.5, patience: 2, debounceMs: 1500, sessionOptions: {}, ...opts };
    this.ready = false;
  }

  async init() {
    const so = { executionProviders: ['wasm'], ...this.opts.sessionOptions };
    const create = (src) => this.ort.InferenceSession.create(src, so);
    [this.mel, this.emb, this.clf] = await Promise.all(
      [this.opts.melspec, this.opts.embedding, this.opts.model].map(create));
    this.melIn = this.mel.inputNames[0];
    this.embIn = this.emb.inputNames[0];
    this.clfIn = this.clf.inputNames[0];
    this.seedFeat = await this._noiseEmbeddings();
    this.reset();
    this.ready = true;
    return this;
  }

  async _noiseEmbeddings() {
    // openwakeword AudioFeatures.reset(): embeddings of 4 s of uniform random int16 noise in [-1000, 1000)
    const T = this.ort.Tensor;
    const n = 16000 * 4;
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = Math.floor(Math.random() * 2000) - 1000;
    const m = (await this.mel.run({ [this.melIn]: new T('float32', noise, [1, n]) }))[this.mel.outputNames[0]];
    const frames = m.dims[m.dims.length - 2];
    const mel = Float32Array.from(m.data, (v) => v / 10 + 2);
    const rows = [];
    for (let s = 0; s + MEL_WINDOW <= frames; s += 8) {
      const win = mel.slice(s * 32, (s + MEL_WINDOW) * 32);
      const e = (await this.emb.run({ [this.embIn]: new T('float32', win, [1, MEL_WINDOW, 32, 1]) }))[this.emb.outputNames[0]];
      rows.push(Float32Array.from(e.data.subarray(0, 96)));
    }
    return rows;
  }

  reset() {
    this.raw = new Float32Array(0);           // last RAW_MAX samples (int16 scale)
    this.pending = new Float32Array(0);       // samples not yet forming a full 1280 chunk
    this.melBuf = [];                         // rows of Float32Array(32)
    for (let i = 0; i < MEL_WINDOW; i++) this.melBuf.push(new Float32Array(32).fill(1));
    // like openwakeword: the feature buffer starts with embeddings of 4 s of low-level random noise
    this.feat = (this.seedFeat || []).map((r) => Float32Array.from(r));
    while (this.feat.length < EMB_FRAMES) this.feat.unshift(new Float32Array(96));
    this.frames = 0;
    this.run = 0;
    this.lastWake = -Infinity;
  }

  static toInt16Scale(chunk) {
    // accepts Int16Array (as is) or Float32Array in [-1, 1] (scaled to int16 range, as the models expect)
    if (chunk instanceof Int16Array) return Float32Array.from(chunk);
    const out = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      out[i] = Math.trunc(v * 32767);
    }
    return out;
  }

  _appendRaw(x) {
    const n = Math.min(RAW_MAX, this.raw.length + x.length);
    const out = new Float32Array(n);
    const keep = n - x.length;
    if (keep > 0) out.set(this.raw.subarray(this.raw.length - keep), 0);
    out.set(x.subarray(Math.max(0, x.length - n)), Math.max(0, keep));
    this.raw = out;
  }

  async _step(chunk) {
    const T = this.ort.Tensor;
    this._appendRaw(chunk);
    // 1. melspectrogram of the newest 1280 samples + 480 samples of context
    const take = Math.min(this.raw.length, CHUNK + MEL_CONTEXT);
    const melInput = this.raw.slice(this.raw.length - take);
    const melOut = (await this.mel.run({ [this.melIn]: new T('float32', melInput, [1, take]) }));
    const m = melOut[this.mel.outputNames[0]];
    const nFrames = m.dims[m.dims.length - 2];
    for (let f = 0; f < nFrames; f++) {
      const row = new Float32Array(32);
      for (let b = 0; b < 32; b++) row[b] = m.data[f * 32 + b] / 10 + 2;
      this.melBuf.push(row);
    }
    if (this.melBuf.length > MEL_MAX) this.melBuf.splice(0, this.melBuf.length - MEL_MAX);
    // 2. embedding of the last 76 mel frames
    const win = new Float32Array(MEL_WINDOW * 32);
    const start = this.melBuf.length - MEL_WINDOW;
    for (let i = 0; i < MEL_WINDOW; i++) win.set(this.melBuf[start + i], i * 32);
    const e = (await this.emb.run({ [this.embIn]: new T('float32', win, [1, MEL_WINDOW, 32, 1]) }))[this.emb.outputNames[0]];
    this.feat.push(Float32Array.from(e.data.subarray(0, 96)));
    if (this.feat.length > FEAT_MAX) this.feat.splice(0, this.feat.length - FEAT_MAX);
    // 3. wake model on the last 16 embeddings
    const x = new Float32Array(EMB_FRAMES * 96);
    const fs = this.feat.length - EMB_FRAMES;
    for (let i = 0; i < EMB_FRAMES; i++) x.set(this.feat[fs + i], i * 96);
    const out = (await this.clf.run({ [this.clfIn]: new T('float32', x, [1, EMB_FRAMES, 96]) }))[this.clf.outputNames[0]];
    this.frames += 1;
    return this.frames <= 5 ? 0 : out.data[0];   // same warm-up as openwakeword.Model
  }

  // Feed any number of samples (Int16Array, or Float32Array in [-1,1]). Returns one result per completed
  // 1280-sample chunk: [{ score, wake, frame }]. `wake` applies patience + debounce like the Pi gate.
  async process(samples, nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    const x = WakeWordDetector.toInt16Scale(samples);
    const all = new Float32Array(this.pending.length + x.length);
    all.set(this.pending, 0);
    all.set(x, this.pending.length);
    const results = [];
    let off = 0;
    for (; off + CHUNK <= all.length; off += CHUNK) {
      const score = await this._step(all.subarray(off, off + CHUNK));
      this.run = score >= this.opts.threshold ? this.run + 1 : 0;
      let wake = false;
      if (this.run >= this.opts.patience && nowMs - this.lastWake > this.opts.debounceMs) {
        wake = true;
        this.run = 0;
        this.lastWake = nowMs;
      }
      results.push({ score, wake, frame: this.frames });
    }
    this.pending = all.slice(off);
    return results;
  }
}

// Minimal 16-bit PCM WAV encoder (used by the clip recorder).
export function encodeWav(int16, sampleRate = 16000) {
  const buf = new ArrayBuffer(44 + int16.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + int16.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return buf;
}

// Minimal WAV decoder (PCM16 mono/stereo) -> Int16Array mono + sampleRate.
export function decodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  let off = 12, fmt = null;
  while (off + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { ch: v.getUint16(off + 10, true), sr: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV supported');
      const n = size / 2 / fmt.ch;
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(off + 8 + i * 2 * fmt.ch, true);
      return { samples: out, sampleRate: fmt.sr };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
