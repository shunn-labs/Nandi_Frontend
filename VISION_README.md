# Nandi Frontend — Vision Integration

## What changed in v3

### Layout
- Chat area is now constrained to **720px max-width**, centered like ChatGPT/Claude
- Vision column widened to **400px** for proper streams
- Removed the "Vision ready / Click Start" footer
- Orb shrunk slightly to give chat more vertical room

### Vision system
- **VisionManager** — receives commands from your vision agent via WebSocket
- **VisionBox** — single stream/frame display with **📸 capture** and **✕ close** buttons
- **Multi-stream stacking** — boxes stack newest-at-bottom in the right column. When too many, the column scrolls. (Simpler than dynamic relayout; you always see at least the latest one.)
- **Camera button** = WebRTC producer. Pressing it starts streaming your device camera to the vision server with `stream_id = web_react_<deviceName>_camera`.

## How vision results reach the browser (automatic)

Nothing to configure. Every browser tab opens `/ws/vision-control` on the brain,
authenticates with its JWT and registers its `client_id` (`web_react_<deviceName>`)
and `device_name`. Every chat message carries the same `client_id`, so the brain
always knows which device a request came from.

```
You (on "somnath-pc"): "take a snapshot of the PC camera and show me"
   │  /ws/chat {query, client_id, device_name, request_id}
   ▼
Brain agent ──MCP──► Vision server  take_snapshot(cameras=["PC camera"])
   ▲                        │ returns the JPEG + a `display` directive
   └────────────────────────┘
Brain ──/ws/vision-control──► the same device ("somnath-pc") → a VisionBox opens
```

- The vision server never needs a client id or URL; the old `CLIENT_REGISTRY`
  dictionary is gone.
- Pushes fan out to every tab of the same device. If the device you're talking
  from has no display connected, the brain uses your most recently active device
  that does, and the answer says so.
- The vision column opens by itself when a frame or live view arrives.
- While the brain works, the "Thinking…" line shows progress ("Running face
  detection on PC camera…"). If something fails, the answer explains why and a
  collapsible **Problems** block lists each issue with a fix hint.

Messages the browser receives on `/ws/vision-control`:

```json
{"action": "show_frame",  "wid": "frame_…", "label": "PC camera — face recognition", "image_b64": "…", "mime": "image/jpeg", "request_id": "…"}
{"action": "show_stream", "wid": "stream_<id>", "label": "…", "stream_id": "<id>"}
{"action": "close", "wid": "…"}
{"action": "close_all"}
```

The REST dispatch endpoints (`/api/vision/dispatch/{client_id}/…`) still exist
for scripts, but require the `x-dispatch-key` header (brain env
`VISION_DISPATCH_KEY`).

## Vision server URL

The browser talks to the vision server directly over WebSocket (`src/lib/visionFrames.js`):
camera frames go up on `/ws/frames/<stream_id>`, live views come down on
`/ws/view/<stream_id>`. The setting is still called the signaling URL (default
`wss://vision.shunnlabs.in/ws/signal`); the two paths are derived from it. To
override for dev, run this in the browser console:

```js
localStorage.setItem('nandi_vision_signal_url', 'ws://localhost:8765/ws/signal')
```

Then reload. (`src/lib/webrtcConsumer.js`, the old WebRTC transport, is no
longer imported: between a browser and the vision server WebRTC ran over UDP
with no relay, which gave corrupted, downscaled pictures and growing lag.)

## Camera button behavior

- Click camera icon → asks for camera permission, opens local stream
- Starts a frame producer with `stream_id = web_react_<device>_camera`: JPEG
  frames over WebSocket, at the rate the server asks for (~1 fps while nothing
  uses the camera, the view's fps while a live view runs; one full-quality
  frame on request for snapshots and one-shot analysis)
- A VisionBox appears in the right column showing the local preview
- Click the camera icon again, or the box's ✕ button, to stop

Nandi can then analyse it from any of your devices — e.g. "what am I holding up to my camera?" uses this device's browser camera when it is live.

## Capture button (📸)

On any VisionBox, the 📸 button grabs the current frame and adds it to the chat as an uploaded attachment, so you can ask a question about it.
