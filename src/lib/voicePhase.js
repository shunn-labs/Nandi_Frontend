// The wake-word voice mode's phases (wakeVoice.js), in a module of their own so
// the main bundle can name them without loading voice mode itself (Pipecat and
// its WebRTC transport stay in the lazy VoiceMode chunk).
export const PHASE = {
  OPEN: 'open',              // no wake word: always listening
  SLEEPING: 'sleeping',
  LISTEN: 'listen',
  HEARING: 'hearing',
  REPLYING: 'replying',
  FOLLOWUP: 'followup',
}
