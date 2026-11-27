# React Voice & Files Chat UI

## Quick start

```bash
npm create vite@latest
# (skip) — or just clone/extract this folder

# Inside this project:
npm install
npm run dev
```

Open http://localhost:5173

> Voice recognition works best in Chrome on desktop. Some browsers don’t support it.

The dev server always uses port **5173** (`strictPort`). If something else holds 5173 (another Vite app),
it refuses to start rather than moving to 5174. That is deliberate: 5174 is a different site to the browser,
so it would ask for the microphone again, and the audio server's CORS list only allows `localhost:5173`.

## Voice mode and the “Hey Nandi” wake word

Open voice mode with **Ctrl+H** (Ctrl on every OS; it works while typing too), the voice button, or the
command palette. It stays on until you end it (Ctrl+H again, or End). It behaves like the Raspberry Pi voice
client:

| Phase | What happens |
|---|---|
| **Say “Hey Nandi”** (asleep) | The mic is closed to the server. Only the on-device wake word listens. Saying "hey Nandi", "hi Nandi", tapping **Wake** or tapping the globe wakes her, with a rising beep. |
| **Listening → Hearing you** | The mic is open. If you say nothing within 6 s she goes back to sleep (falling beep). The audio server decides when your sentence ends. |
| **Thinking / Speaking** | The mic is closed again, so room talk can't interrupt her. **"Hey Nandi" interrupts:** her voice ducks, you speak, and she stops. |
| **Go on…** (follow-up) | For 15 s after a reply you can keep talking without the wake word. Then she sleeps. |

Other behaviour:
- **Drops:** if the connection drops (network, server restart, idle timeout), voice mode reconnects by itself, waiting 1, 2, 4 … 30 s between tries.
- **Settings ▸ Voice:**
  - wake word on/off (off = always listening, the old behaviour);
  - sensitivity: Normal = 0.95, the default; Strict = the model's 0.99; Sensitive = 0.9;
  - follow-up time;
  - beeps.

How it works:
- `src/lib/wakeVoice.js` holds the phases.
- `src/lib/wakeword/` holds the detector. `oww.js` and `worklet.js` are copied unchanged from
  [shunn-labs/Nandi_WakeWord](https://github.com/shunn-labs/Nandi_WakeWord) `integration/web/`.
- onnxruntime-web runs it as single-threaded WASM, so no special headers are needed. It loads only with voice
  mode, not with the main bundle.
- The detector listens to a clone of the voice session's mic track, so there's one capture and no second
  permission prompt.

**The model** lives in `public/wakeword/hey_nandi-2026-11-26/` (see `SOURCE.md` there). It is the `hey_nandi`
model trained with real recordings (Nandi_WakeWord PR #1), which beat the synthetic-only baseline on real
recordings: 90 % vs 0 % recall.
- **Updating it:** copy the new `.onnx`/`.json` into a new versioned folder, and point `WAKE_MODEL_DIR` in
  `src/lib/wakeword/wakeListener.js` at it. The folder name is the cache-buster.

## Microphone / camera permission

A web page can't grant itself permission. The browser remembers it **per site (origin)**, across restarts and
days, until you clear the site's data, but only if you pick the persistent option when it asks:
- **Chrome / Edge:** "Allow while visiting the site", not "Allow this time".
- **Firefox:** tick "Remember this decision".
- **Safari:** Settings for this website ▸ Microphone/Camera ▸ Allow.

Settings ▸ Voice ▸ *Microphone & camera access* shows the current state and has an **Allow now** button that
grants both at once, so later features don't stop to ask. If the browser forgets an earlier "yes", voice mode
explains how to make it stick. The app also skips its extra "is the mic allowed?" request once permission is
already granted.

## Hooking up your own AI

Open `src/lib/aiAdapter.js` and set `USE_MOCK = false`. Replace the example with a `fetch` call to your backend (or OpenAI proxy). You’ll receive the full `history` and `attachments` metadata.

```js
export async function chat(history, attachments){
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history, attachments })
  })
  const data = await res.json()
  return data.reply
}
```

## Build

```bash
npm run build
npm run preview
```
