// ═══════════════════════════════════════════════════════════
//  beeps.js  –  voice-mode cues, the same tones as the Raspberry Pi client
//
//  Synthesised (no files): sine notes with 12 ms fades and 30 ms of silence
//  after each, exactly as Nandi_Voice_Client's prompts.py:
//    wake       1046.5 Hz 180 ms → 1568 Hz 320 ms   (rising)   −14 dBFS
//    sleep      1318.5 Hz 160 ms → 880 Hz 280 ms    (falling)  −19 dBFS
//    ready      659.3 Hz 110 ms → 987.8 Hz 160 ms             −16 dBFS
//    connected  880 Hz 90 ms                                   −16 dBFS
//    error      659.3 Hz 140 ms → 440 Hz 220 ms               −16 dBFS
//  Played on the page's shared audio context (chime.js), which the first
//  click/key press unlocks.
// ═══════════════════════════════════════════════════════════

import { audioContext } from './chime.js'

const TONES = {
  wake: { db: -14, notes: [[1046.5, 0.18], [1568, 0.32]] },
  sleep: { db: -19, notes: [[1318.5, 0.16], [880, 0.28]] },
  ready: { db: -16, notes: [[659.3, 0.11], [987.8, 0.16]] },
  connected: { db: -16, notes: [[880, 0.09]] },
  error: { db: -16, notes: [[659.3, 0.14], [440, 0.22]] },
}
const FADE = 0.012
const GAP = 0.03

/** Play a cue: 'wake' | 'sleep' | 'ready' | 'connected' | 'error'. Never throws. */
export function playBeep(kind) {
  const tone = TONES[kind]
  if (!tone) return
  try {
    const c = audioContext()
    if (!c) return
    if (c.state === 'suspended') c.resume().catch(() => {})
    const peak = 10 ** (tone.db / 20)
    let t = c.currentTime + 0.02
    for (const [freq, len] of tone.notes) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(peak, t + FADE)
      gain.gain.setValueAtTime(peak, t + len - FADE)
      gain.gain.linearRampToValueAtTime(0, t + len)
      osc.connect(gain).connect(c.destination)
      osc.start(t)
      osc.stop(t + len + 0.01)
      t += len + GAP
    }
  } catch { /* audio unavailable */ }
}
