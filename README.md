# Nandi Frontend

React 18 + Vite single-page app for the Nandi assistant: chat, voice, files,
live camera views and approval cards. It talks to the Nandi brain (REST +
WebSockets) and to the vision server (WebRTC signaling).

## Quick start (development)

```bash
npm install
npm run dev          # http://localhost:5173
```

A dev build talks to `http://127.0.0.1:8000` (brain) and
`ws://127.0.0.1:8765/ws/signal` (vision). Override with env vars:

```bash
VITE_API_BASE=https://nandi.example.com \
VITE_VISION_SIGNAL_URL=wss://nandi.example.com/vision/ws/signal \
npm run dev
```

## Configuration

One production build runs anywhere. Settings are resolved in this order:

1. **`/config.js` at runtime.** The Nandi gateway serves it and sets
   `window.__NANDI_CONFIG__`:

   ```js
   window.__NANDI_CONFIG__ = {
     apiBase: '',          // brain base URL; empty = this page's origin
     visionSignalUrl: '',  // empty = ws(s)://<this host>/vision/ws/signal
     googleClientId: '',   // empty = no Google button (local login only)
     iceServers: [],       // STUN/TURN list; empty = Google STUN
     productName: 'Nandi AI',
   }
   ```

   Every field is optional. If `/config.js` is missing, the defaults apply.
2. **Build-time env:** `VITE_API_BASE`, `VITE_VISION_SIGNAL_URL`,
   `VITE_GOOGLE_CLIENT_ID`, `VITE_ICE_SERVERS` (a JSON array).
3. **Defaults:** in a production build the brain is the page's own origin and
   the vision server is at `/vision/ws/signal` on the same host.

For one browser only, you can point at a different vision server with
`localStorage.nandi_vision_signal_url`.

## Sign-in

The login page asks the brain (`GET /auth/config`) which methods are enabled:

- **Email + password:** the admin account created during install
  (`POST /auth/login`).
- **Google:** shown only when a Google OAuth client id is configured. The
  Google script is loaded only in that case.

## Voice

- **Server voice:** text-to-speech needs an OpenAI key on the brain. If the
  brain answers 501, the app falls back to the browser's built-in speech.
- **Speech-to-text:** needs an OpenAI or Groq key. Without one, the mic button
  shows a short explanation.

## Build

```bash
npm run build        # outputs dist/
npm run preview
```
