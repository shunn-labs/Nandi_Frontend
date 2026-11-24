// ═══════════════════════════════════════════════════════════
//  speechBus.js  –  "is Nandi talking?" and "stop talking", in one place
//
//  Nandi talks in two ways outside voice mode: a reply read out by ttsPlayer,
//  and clips the brain plays on this screen in her voice (the audio server's
//  speak tool sends them as play_audio with the label "Nandi"). Interrupting
//  her — the globe, Space, Esc, the mic, typing — must silence both, and the
//  globe should show "speaking" for both.
//
//  Clip players register here (AudioBox does it for Nandi's clips) with
//  stop() and their playing state; ChatView subscribes to know when a clip is
//  talking.
// ═══════════════════════════════════════════════════════════

import { stop as stopTts, getIsBusy } from './ttsPlayer.js'

const players = new Set()        // { stop(), playing: bool }
const listeners = new Set()      // (clipTalking: bool) => void

const clipTalking = () => [...players].some(p => p.playing)

function notify() {
  const talking = clipTalking()
  for (const fn of listeners) {
    try { fn(talking) } catch (err) { console.error('[speech] listener failed:', err) }
  }
}

/**
 * Register a player of Nandi's voice (a clip). Returns
 * { setPlaying(bool), unregister() }.
 */
export function registerSpeechPlayer(stop) {
  const player = { stop, playing: false }
  players.add(player)
  return {
    setPlaying(on) {
      if (player.playing === !!on) return
      player.playing = !!on
      notify()
    },
    unregister() {
      if (!players.delete(player)) return
      if (player.playing) notify()
    },
  }
}

/** Calls `fn(clipTalking)` whenever one of Nandi's clips starts or stops. Returns an unsubscribe. */
export function onClipTalking(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Nandi is talking, or about to (a reply is still loading), or one of her clips plays. */
export function isSpeechBusy() {
  return getIsBusy() || clipTalking()
}

/** Silence Nandi: the reply being read out and any clip of hers that is playing. */
export function stopSpeech() {
  stopTts()
  for (const p of [...players]) {
    if (!p.playing) continue
    try { p.stop() } catch (err) { console.warn('[speech] could not stop a clip:', err) }
  }
}
