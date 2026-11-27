// AudioWorklet: mic -> 16 kHz mono Float32 chunks of 1280 samples (80 ms), posted to the main thread.
// If the AudioContext could not be created at 16 kHz (some browsers ignore the request), it
// downsamples here with a box filter + linear interpolation (fine for speech features).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;   // `sampleRate` is the context rate (AudioWorkletGlobalScope)
    this.pos = 0;                      // fractional read position into `this.src`
    this.src = new Float32Array(0);
    this.out = new Float32Array(1280);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    const merged = new Float32Array(this.src.length + ch.length);
    merged.set(this.src, 0);
    merged.set(ch, this.src.length);
    const r = this.ratio, half = Math.max(1, Math.floor(r / 2));
    while (this.pos + half + 1 < merged.length) {
      const i = Math.floor(this.pos);
      let acc = 0, cnt = 0;
      for (let k = Math.max(0, i - half); k <= i + half; k++) { acc += merged[k]; cnt++; }
      this.push(acc / cnt);
      this.pos += r;
    }
    const drop = Math.max(0, Math.floor(this.pos) - half);
    this.src = merged.slice(drop);
    this.pos -= drop;
    return true;
  }

  push(v) {
    this.out[this.n++] = v;
    if (this.n === 1280) {
      this.port.postMessage(this.out.slice(0));
      this.n = 0;
    }
  }
}
registerProcessor('pcm-capture', PcmCapture);
