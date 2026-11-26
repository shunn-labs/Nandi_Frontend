// ═══════════════════════════════════════════════════════════
//  visionFrames.js  –  camera frames to / from the vision server over WebSocket
//
//  Replaces WebRTC for the browser (webrtcConsumer.js is no longer used).
//  WebRTC between a browser and the vision server went over UDP with no TURN
//  relay: a lossy link gave block corruption, Chrome shrank the picture it
//  sent, and the server re-encoded the annotated video at 0.5–1.5 Mbps, so
//  everything the user saw (and every frame the models saw) was soft or
//  broken, and lag built up. Here each frame is one JPEG in one WebSocket
//  message over the same wss:// the app already uses: either it arrives
//  whole and sharp or not at all, and the newest frame always wins.
//
//  Producer  (startFrameProducer)  ws://…/ws/frames/<stream_id>
//    The SERVER says what it needs: {type:'want', fps, max_width, quality}.
//    Idle it asks ~1 fps; a live detection view raises that to its fps. Flow
//    control is a credit count (one credit per frame, returned by 'ack'), so
//    a slow uplink lowers the fps instead of queueing frames. A
//    {type:'snapshot', id, max_width, quality} request is answered with one
//    full-size, high-quality frame — what "take a photo" / one-shot analysis
//    gets.
//    frame = 20-byte header + JPEG:  'NVF1', kind u8 (0 stream, 1 snapshot),
//    flags u8, seq u16, capture_ms f64 (Date.now()), req_id u32 — big endian.
//
//  Consumer  (startFrameConsumer)  ws://…/ws/view/<stream_id>
//    <camera> gives the camera's frames, <camera>_<task> the annotated results.
//    frame = 20-byte header + JSON meta + JPEG:  'NVV1', kind u8, flags u8,
//    seq u32, ts_ms f64, meta_len u16. The client acks each frame after
//    drawing it; the server keeps one frame in flight and always sends its
//    newest, so a slow tab sees fewer frames, never a growing delay.
// ═══════════════════════════════════════════════════════════

import { getVisionFramesUrl, getVisionViewUrl } from './endpoints.js'
import { getClientId } from './clientId.js'

const PING_INTERVAL_MS = 25000
const MAX_RECONNECT_DELAY = 15000
const REPLACED_CODE = 4001            // the server: a newer socket took this stream id
const DEFAULT_WANT = { fps: 1, max_width: 1280, quality: 0.7 }
const DEFAULT_CREDITS = 2

function backoff(attempt) {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_DELAY)
  return Math.round(base * (0.7 + Math.random() * 0.6))
}

function packFrameHeader(kind, seq, captureMs, reqId) {
  const buf = new ArrayBuffer(20)
  const dv = new DataView(buf)
  dv.setUint8(0, 0x4e); dv.setUint8(1, 0x56); dv.setUint8(2, 0x46); dv.setUint8(3, 0x31)   // NVF1
  dv.setUint8(4, kind)
  dv.setUint8(5, 0)
  dv.setUint16(6, seq & 0xffff)
  dv.setFloat64(8, captureMs)
  dv.setUint32(16, reqId >>> 0)
  return buf
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

// ════════════════════════ PRODUCER ════════════════════════

/**
 * Share this device's camera with the vision server.
 *
 * Same shape as the old WebRTC producer, so the camera tile and the hook do
 * not change: { getStream, switchCamera, onStreamChange, getFacingMode, close }.
 * The local MediaStream is kept for the "My camera" preview; frames are drawn
 * from a hidden <video> onto a canvas and sent as JPEG at the rate the server
 * asks for.
 */
export async function startFrameProducer({ streamId, facingMode = 'environment', callbacks = {}, fallback = '' } = {}) {
  const { onState, onLog } = callbacks
  const log = (text, type = 'info') => onLog?.(text, type)

  let currentStream = null
  let currentFacing = facingMode
  let ws = null
  let closed = false
  let reconnectTimer = null
  let attempts = 0
  let pingTimer = null
  let tickTimer = null
  let want = { ...DEFAULT_WANT }
  let credits = DEFAULT_CREDITS
  let encoding = false
  let seq = 0
  const stats = { sent: 0, acked: 0, snapshots: 0, encodeMs: 0 }
  const streamListeners = []

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })

  async function acquire(mode) {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  }

  async function attach(stream) {
    currentStream = stream
    video.srcObject = stream
    try { await video.play() } catch { /* autoplay: muted video is allowed; a late play() is harmless */ }
  }

  await attach(await acquire(currentFacing))
  log(`Got camera (${currentFacing})`, 'ok')

  // ── encode one frame of the live picture ──────────────────
  async function grab(maxWidth, quality) {
    const vw = video.videoWidth, vh = video.videoHeight
    if (!vw || !vh) return null
    const scale = Math.min(1, maxWidth / vw)
    const w = Math.round(vw * scale), h = Math.round(vh * scale)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const t0 = performance.now()
    ctx.drawImage(video, 0, 0, w, h)
    const blob = await toBlob(canvas, quality)
    stats.encodeMs = Math.round(performance.now() - t0)
    return blob
  }

  function send(sock, header, blob) {
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) return false
    sock.send(new Blob([header, blob]))
    return true
  }

  async function tick(sock) {
    if (ws !== sock || closed) return
    if (credits > 0 && !encoding && document.visibilityState !== 'hidden') {
      encoding = true
      try {
        const blob = await grab(want.max_width, want.quality)
        if (blob && ws === sock) {
          credits -= 1
          seq = (seq + 1) & 0xffff
          if (send(sock, packFrameHeader(0, seq, Date.now(), 0), blob)) stats.sent += 1
        }
      } catch (err) {
        log(`frame encode failed: ${err.message}`, 'err')
      } finally {
        encoding = false
      }
    }
    if (ws === sock && !closed) {
      tickTimer = setTimeout(() => tick(sock), 1000 / Math.max(0.2, want.fps))
    }
  }

  async function snapshot(sock, msg) {
    try {
      const blob = await grab(msg.max_width || 1280, msg.quality || 0.92)
      if (blob && send(sock, packFrameHeader(1, 0, Date.now(), msg.id || 0), blob)) stats.snapshots += 1
    } catch (err) {
      log(`snapshot failed: ${err.message}`, 'err')
    }
  }

  // ── socket ────────────────────────────────────────────────
  function stopTimers() {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    attempts += 1
    const delay = backoff(attempts)
    log(`Reconnect in ${(delay / 1000).toFixed(1)}s`, 'info')
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
  }

  function connect() {
    if (closed) return
    // `fallback`: why the media hub was not used (the caller tried it first). The
    // server logs it, so a camera stuck on JPEG frames can be told apart from an
    // old page that never tried the hub.
    const url = getVisionFramesUrl(streamId)
      + (fallback ? `?fallback=${encodeURIComponent(String(fallback).slice(0, 200))}` : '')
    log(`Producer connecting → ${url}`, 'info')
    let sock
    try { sock = new WebSocket(url) } catch (err) {
      log(`WS error: ${err.message}`, 'err')
      scheduleReconnect()
      return
    }
    ws = sock
    onState?.('connecting')

    sock.onopen = () => {
      if (ws !== sock) return
      sock.send(JSON.stringify({
        type: 'hello', client: getClientId(), v: 1,
        caps: { width: video.videoWidth, height: video.videoHeight, facing: currentFacing },
      }))
      pingTimer = setInterval(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }))
      }, PING_INTERVAL_MS)
    }

    sock.onmessage = (ev) => {
      if (ws !== sock) return
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'hello':
          attempts = 0
          credits = msg.credits ?? DEFAULT_CREDITS
          if (msg.want) want = { ...want, ...msg.want }
          log(`Registered as producer ${streamId} (${want.fps} fps wanted)`, 'ok')
          onState?.('connected')
          stopTimers()
          pingTimer = setInterval(() => {
            if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }))
          }, PING_INTERVAL_MS)
          tick(sock)
          break
        case 'want':
          want = { ...want, fps: msg.fps ?? want.fps, max_width: msg.max_width ?? want.max_width,
            quality: msg.quality ?? want.quality }
          log(`Server wants ${want.fps} fps (${msg.reason || ''})`, 'info')
          break
        case 'ack':
          credits = Math.min(DEFAULT_CREDITS, credits + 1)
          stats.acked += 1
          break
        case 'snapshot':
          snapshot(sock, msg)
          break
        case 'error':
          log(`server: ${msg.error || msg.message}`, 'err')
          break
        default:
          break
      }
    }

    sock.onerror = () => { /* onclose decides */ }

    sock.onclose = (event) => {
      if (ws !== sock) return
      stopTimers()
      ws = null
      if (closed) return
      if (event.code === REPLACED_CODE) {
        // This camera id was opened again (another tab, a reload). The newer
        // one owns it now; retrying would just fight it.
        log('Replaced by a newer producer for this camera — stopped', 'warn')
        onState?.('replaced')
        return
      }
      log(`Producer socket closed (${event.code})`, 'info')
      onState?.('disconnected')
      scheduleReconnect()
    }
  }

  // ── public API (same as the WebRTC producer) ──────────────
  async function switchCamera() {
    const next = currentFacing === 'environment' ? 'user' : 'environment'
    const stream = await acquire(next)
    const old = currentStream
    currentFacing = next
    await attach(stream)
    old?.getTracks().forEach(t => t.stop())
    streamListeners.forEach(cb => cb(stream))
    log(`Switched to ${next}`, 'ok')
    return next
  }

  function onStreamChange(cb) {
    streamListeners.push(cb)
    return () => {
      const i = streamListeners.indexOf(cb)
      if (i >= 0) streamListeners.splice(i, 1)
    }
  }

  function close() {
    closed = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    stopTimers()
    try { ws?.close() } catch { /* already closed */ }
    ws = null
    currentStream?.getTracks().forEach(t => t.stop())
    video.srcObject = null
  }

  connect()

  return {
    transport: 'ws',
    path: 'jpeg',
    fallback,
    getStream: () => currentStream,
    getFacingMode: () => currentFacing,
    switchCamera,
    onStreamChange,
    close,
    getStats: () => ({ ...stats, want: { ...want }, credits }),
  }
}

// ════════════════════════ CONSUMER ════════════════════════

const textDecoder = new TextDecoder()

function parseViewFrame(buffer) {
  const dv = new DataView(buffer)
  if (buffer.byteLength < 20 || dv.getUint8(0) !== 0x4e || dv.getUint8(1) !== 0x56 ||
      dv.getUint8(2) !== 0x56 || dv.getUint8(3) !== 0x31) return null            // NVV1
  const kind = dv.getUint8(4)
  const seq = dv.getUint32(6)
  const tsMs = dv.getFloat64(10)
  const metaLen = dv.getUint16(18)
  let meta = {}
  try { meta = JSON.parse(textDecoder.decode(new Uint8Array(buffer, 20, metaLen))) } catch { /* keep {} */ }
  const blob = new Blob([new Uint8Array(buffer, 20 + metaLen)], { type: 'image/jpeg' })
  return { kind, seq, tsMs, meta, blob }
}

function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')) }
    img.src = url
  })
}

/**
 * Watch a stream: the camera's own frames (<camera>) or a processed view
 * (<camera>_<task>).
 *
 * @param {string} streamId
 * @param {object} callbacks  { onFrame(image, meta, blob), onState(state), onLog(text, type) }
 *   image is an ImageBitmap (or an HTMLImageElement on old browsers) ready to
 *   draw; blob is the JPEG itself; meta is the server's note about the frame
 *   (text, count, rtt_ms for processed views; width/height for raw ones).
 *   state: 'connecting' | 'live' | 'waiting' | 'offline' | 'disconnected'
 * @returns {object}  { close, refresh, getLastFrame }
 */
export function startFrameConsumer(streamId, callbacks = {}) {
  const { onFrame, onState, onLog } = callbacks
  const log = (text, type = 'info') => onLog?.(text, type)

  let ws = null
  let closed = false
  let reconnectTimer = null
  let attempts = 0
  let pingTimer = null
  let drawing = false
  let last = null                       // { blob, meta, width, height, seq }
  let state = ''
  const setState = (s) => { if (s !== state) { state = s; onState?.(s) } }

  function teardown() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    const sock = ws
    ws = null
    try { sock?.close() } catch { /* already closed */ }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    attempts += 1
    const delay = backoff(attempts)
    log(`Reconnect in ${(delay / 1000).toFixed(1)}s`, 'info')
    reconnectTimer = setTimeout(() => { reconnectTimer = null; teardown(); connect() }, delay)
  }

  async function handleFrame(sock, buffer) {
    const frame = parseViewFrame(buffer)
    if (!frame) return
    if (drawing) {                         // should not happen (one in flight), but never pile up
      sock.send(JSON.stringify({ type: 'ack', seq: frame.seq }))
      return
    }
    drawing = true
    try {
      const image = await decodeImage(frame.blob)
      if (ws !== sock) { image.close?.(); return }
      attempts = 0
      last = { blob: frame.blob, meta: frame.meta, width: image.width, height: image.height, seq: frame.seq }
      setState('live')
      onFrame?.(image, frame.meta, frame.blob)
    } catch (err) {
      log(`frame decode failed: ${err.message}`, 'err')
    } finally {
      drawing = false
      if (ws === sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'ack', seq: frame.seq }))
      }
    }
  }

  function onVisibility() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: document.visibilityState === 'hidden' ? 'pause' : 'resume' }))
    }
  }

  function connect() {
    if (closed) return
    const url = getVisionViewUrl(streamId)
    log(`Connecting → ${url}`, 'info')
    let sock
    try { sock = new WebSocket(url) } catch (err) {
      log(`WS error: ${err.message}`, 'err')
      scheduleReconnect()
      return
    }
    sock.binaryType = 'arraybuffer'
    ws = sock
    setState('connecting')

    sock.onopen = () => {
      if (ws !== sock) return
      pingTimer = setInterval(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }))
      }, PING_INTERVAL_MS)
      if (document.visibilityState === 'hidden') sock.send(JSON.stringify({ type: 'pause' }))
    }

    sock.onmessage = (ev) => {
      if (ws !== sock) return
      if (ev.data instanceof ArrayBuffer) { handleFrame(sock, ev.data); return }
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'hello') log(`Viewing ${msg.stream_id} (${msg.kind})`, 'ok')
      else if (msg.type === 'state') {
        // 'live' is only reported once a frame has actually been drawn.
        if (msg.state !== 'live') setState(msg.state)
      }
    }

    sock.onerror = () => { /* onclose decides */ }

    sock.onclose = (event) => {
      if (ws !== sock) return            // an old socket; a newer one owns the view
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      ws = null
      if (closed) return
      log(`View socket closed (${event.code})`, 'info')
      setState('disconnected')
      scheduleReconnect()
    }
  }

  function refresh() {
    if (closed) return
    log('Manual refresh', 'info')
    attempts = 0
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    teardown()
    connect()
  }

  function close() {
    closed = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    document.removeEventListener('visibilitychange', onVisibility)
    teardown()
  }

  document.addEventListener('visibilitychange', onVisibility)
  connect()
  return { close, refresh, getLastFrame: () => last }
}
