// ═══════════════════════════════════════════════════════════
//  webrtcConsumer.js  –  Browser WebRTC consumer + producer
//
//  Consumer: auto-reconnect on offline / signaling drop, manual refresh
//  Producer: robust consumer-join signalling that tolerates
//            - missing / differently-named peer-id fields
//            - answers arriving BEFORE the local offer is finalized
//            - ICE arriving before the answer is applied
//            plus mid-stream camera switching (front ↔ back)
// ═══════════════════════════════════════════════════════════

// Default follows the build mode instead of always being production — a dev
// build used to open WebRTC signaling against the live vision server.
import { getVisionSignalUrl } from './endpoints.js'

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function getSignalUrl() {
  return getVisionSignalUrl()
}

// The vision server authenticates every signaling registration and scopes each
// stream to its owner, so both the consumer and the producer must present the
// same JWT the chat socket uses. Without it, register is refused with 4401 and
// no video ever flows.
function getToken() {
  return localStorage.getItem('user_token')
}

// ════════════════════════ CONSUMER ════════════════════════

/**
 * Start a WebRTC consumer for a stream.
 *
 * @param {string} streamId
 * @param {object} callbacks  { onTrack(MediaStream), onState(state), onLog(text,type) }
 * @returns {object}  { close, refresh }
 *
 * Auto-reconnects when the producer goes offline or signaling drops.
 * Call refresh() to retry immediately, close() to stop permanently.
 */
export function startConsumer(streamId, callbacks = {}) {
  const { onTrack, onState, onLog } = callbacks
  const log = (text, type = 'info') => onLog?.(text, type)

  let ws = null
  let pc = null
  let closed = false
  let reconnectTimer = null
  let attempts = 0

  function teardown() {
    try { pc?.close() } catch {}
    try { ws?.close() } catch {}
    pc = null
    ws = null
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    attempts += 1
    const delay = Math.min(2500 + attempts * 1500, 15000)
    log(`Reconnect in ${(delay / 1000).toFixed(1)}s`, 'info')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      teardown()
      connect()
    }, delay)
  }

  function refresh() {
    if (closed) return

    // If already connected and healthy, don't tear down a working stream.
    // Report 'connected' so the box flips back to "live" instead of getting
    // stuck on a "Connecting…" overlay.
    if (pc && pc.connectionState === 'connected') {
      log('Already connected — refresh skipped', 'info')
      onState?.('connected')
      return
    }

    log('Manual refresh', 'info')
    onState?.('connecting')
    attempts = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    teardown()
    connect()
  }

  function close() {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    teardown()
  }

  function handleOffer(sdp, fromStream) {
    if (pc) {
      try { pc.close() } catch {}
    }
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.ontrack = (e) => {
      log('Video track received', 'ok')
      attempts = 0  // reset on success
      onTrack?.(e.streams[0])
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          to: fromStream,
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          },
        }))
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      log(`peer state: ${state}`, state === 'connected' ? 'ok' : 'info')
      onState?.(state)
      if (state === 'failed' || state === 'disconnected') {
        scheduleReconnect()
      }
    }

    pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        ws.send(JSON.stringify({
          type: 'answer',
          sdp: pc.localDescription.sdp,
          to: fromStream,
        }))
        log('Handshake complete', 'ok')
      })
      .catch(err => {
        log(`Handshake failed: ${err.message}`, 'err')
        scheduleReconnect()
      })
  }

  function connect() {
    if (closed) return

    const url = getSignalUrl()
    log(`Connecting → ${url}`, 'info')
    try {
      ws = new WebSocket(url)
    } catch (err) {
      log(`WS error: ${err.message}`, 'err')
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register', role: 'consumer', stream_id: streamId,
        token: getToken(),
      }))
    }

    ws.onmessage = async (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.type === 'registered') log('Registered', 'ok')
      else if (msg.type === 'waiting') {
        log(msg.message || 'Waiting for producer', 'warn')
        onState?.('waiting')
      }
      else if (msg.type === 'offer') handleOffer(msg.sdp, msg.from_stream)
      else if (msg.type === 'ice' && pc) {
        if (msg.candidate?.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {})
        }
      }
      else if (msg.type === 'stream_offline') {
        log('Producer offline — will retry', 'warn')
        onState?.('offline')
        teardown()
        scheduleReconnect()
      }
    }

    ws.onerror = () => log('Signaling error', 'err')
    ws.onclose = () => {
      if (closed) return
      log('Signaling closed', 'info')
      scheduleReconnect()
    }
  }

  connect()
  return { close, refresh }
}


// ════════════════════════ PRODUCER ════════════════════════

/**
 * Start a WebRTC producer (camera → vision server).
 *
 * Returns: { getStream, close, switchCamera, getFacingMode, onStreamChange }
 *
 *   getStream()       – current MediaStream (for local preview)
 *   switchCamera()    – swaps camera, replaces tracks in all peer connections
 *   onStreamChange(cb)– called with new MediaStream after switchCamera
 *   close()           – stop everything
 */
export async function startProducer({
  streamId,
  facingMode = 'environment',
  callbacks = {},
} = {}) {
  const { onState, onLog } = callbacks
  const log = (text, type = 'info') => onLog?.(text, type)

  let currentStream = null
  let currentFacing = facingMode
  let ws = null
  let closed = false
  const pcs = {}                 // peer_id → RTCPeerConnection
  const pendingPeers = []        // peer_ids awaiting an answer (FIFO fallback)
  const streamListeners = []

  async function acquire(mode) {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  }

  currentStream = await acquire(currentFacing)
  log(`Got camera (${currentFacing})`, 'ok')

  // ── Apply an answer + flush any buffered ICE ──────────────
  async function applyAnswer(pc, peerId, sdp) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }))
      log(`Answer applied for ${peerId}`, 'ok')

      const idx = pendingPeers.indexOf(peerId)
      if (idx >= 0) pendingPeers.splice(idx, 1)

      if (pc._pendingIce?.length) {
        for (const cand of pc._pendingIce) {
          await pc.addIceCandidate(cand).catch(() => {})
        }
        pc._pendingIce = []
      }
    } catch (err) {
      log(`setRemoteDescription failed: ${err.message}`, 'err')
    }
  }

  // ── Setup a new consumer ─────────────────────────────────
  async function startNewConsumer(peerId) {
    log(`New consumer joined: ${peerId}`, 'info')

    if (pcs[peerId]) {
      try { pcs[peerId].close() } catch {}
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcs[peerId] = pc
    pc._pendingIce = []
    pendingPeers.push(peerId)              // track BEFORE any await

    // Add tracks
    currentStream.getTracks().forEach(track => {
      pc.addTrack(track, currentStream)
    })

    pc.onicecandidate = (e) => {
      if (e.candidate && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          to: peerId,
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          },
        }))
      }
    }

    pc.onconnectionstatechange = () => {
      log(`peer ${peerId}: ${pc.connectionState}`, 'info')
      onState?.(pc.connectionState)
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        try { pc.close() } catch {}
        delete pcs[peerId]
        const i = pendingPeers.indexOf(peerId)
        if (i >= 0) pendingPeers.splice(i, 1)
      }
    }

    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false,
      })
      await pc.setLocalDescription(offer)
      ws.send(JSON.stringify({
        type: 'offer',
        sdp: pc.localDescription.sdp,
        to: peerId,
      }))
      log(`Offer sent to ${peerId}`, 'ok')

      // An answer may have raced in before setLocalDescription resolved
      if (pc._pendingAnswer) {
        const sdp = pc._pendingAnswer
        pc._pendingAnswer = null
        await applyAnswer(pc, peerId, sdp)
      }
    } catch (err) {
      log(`Offer failed for ${peerId}: ${err.message}`, 'err')
    }
  }

  // ── Switch camera mid-stream ─────────────────────────────
  async function switchCamera() {
    const newMode = currentFacing === 'environment' ? 'user' : 'environment'
    log(`Switching camera → ${newMode}`, 'info')

    let newStream
    try {
      newStream = await acquire(newMode)
    } catch (err) {
      log(`Switch failed: ${err.message}`, 'err')
      throw err
    }

    const newVideoTrack = newStream.getVideoTracks()[0]
    if (!newVideoTrack) {
      log('No video track in new stream', 'err')
      newStream.getTracks().forEach(t => t.stop())
      return
    }

    // Replace track in every active peer connection
    for (const [pid, pc] of Object.entries(pcs)) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        try {
          await sender.replaceTrack(newVideoTrack)
          log(`Replaced track in peer ${pid}`, 'ok')
        } catch (err) {
          log(`replaceTrack failed for ${pid}: ${err.message}`, 'warn')
        }
      }
    }

    // Stop old stream tracks
    currentStream.getTracks().forEach(t => t.stop())

    currentStream = newStream
    currentFacing = newMode

    // Notify VisionBox so it updates its <video srcObject>
    streamListeners.forEach(cb => {
      try { cb(newStream) } catch {}
    })
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
    currentStream?.getTracks().forEach(t => t.stop())
    Object.values(pcs).forEach(pc => { try { pc.close() } catch {} })
    try { ws?.close() } catch {}
    ws = null
  }

  // ── Connect signaling ────────────────────────────────────
  const url = getSignalUrl()
  log(`Producer connecting → ${url}`, 'info')
  ws = new WebSocket(url)

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'register', role: 'producer', stream_id: streamId,
      token: getToken(),
    }))
    log(`Registered as producer ${streamId}`, 'ok')
  }

  ws.onmessage = async (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    // Log every message — useful for debugging signaling
    log(`producer recv: ${msg.type}`, 'info')

    if (msg.type === 'registered') {
      log(`Server confirmed producer registration`, 'ok')
      return
    }

    // ── New consumer wants the stream ──
    // Server might send any of these patterns; handle them all.
    if (
      msg.type === 'consumer_joined' ||
      msg.type === 'new_consumer' ||
      msg.type === 'consumer_register' ||
      msg.type === 'request_offer'
    ) {
      const peerId = msg.consumer_id || msg.from_stream || msg.from || msg.peer_id
      if (peerId) await startNewConsumer(peerId)
      else log('consumer-join message had no peer id', 'warn')
      return
    }

    // ── Answer from consumer ──
    if (msg.type === 'answer') {
      // To discover the exact field your server uses, uncomment:
      // console.log('ANSWER MSG:', JSON.stringify(msg))

      let peerId = msg.from_stream || msg.from || msg.consumer_id || msg.to
      let pc = peerId ? pcs[peerId] : null

      // FIFO fallback: oldest peer still awaiting an answer
      if (!pc && pendingPeers.length) {
        peerId = pendingPeers[0]
        pc = pcs[peerId]
        log(`Answer matched by FIFO → ${peerId}`, 'info')
      }

      if (!pc) {
        log(`Answer with no matching peer ${peerId}`, 'warn')
        return
      }

      // If the offer's setLocalDescription hasn't resolved yet, buffer the
      // answer and let startNewConsumer apply it once the offer is in place.
      if (pc.signalingState !== 'have-local-offer') {
        pc._pendingAnswer = msg.sdp
        log(`Answer buffered (state=${pc.signalingState})`, 'info')
        return
      }

      await applyAnswer(pc, peerId, msg.sdp)
      return
    }

    // ── ICE from consumer ──
    if (msg.type === 'ice') {
      let peerId = msg.from_stream || msg.from || msg.consumer_id || msg.to
      let pc = peerId ? pcs[peerId] : null

      // Fallback to the single in-progress peer
      if (!pc && pendingPeers.length === 1) {
        peerId = pendingPeers[0]
        pc = pcs[peerId]
      } else if (!pc && Object.keys(pcs).length === 1) {
        peerId = Object.keys(pcs)[0]
        pc = pcs[peerId]
      }

      if (pc && msg.candidate?.candidate) {
        // Queue ICE until remoteDescription is set, else addIceCandidate throws
        if (!pc.remoteDescription) {
          pc._pendingIce = pc._pendingIce || []
          pc._pendingIce.push(msg.candidate)
          return
        }
        try {
          await pc.addIceCandidate(msg.candidate)
        } catch (err) {
          log(`ICE add failed: ${err.message}`, 'warn')
        }
      }
      return
    }

    // ── Consumer left ──
    if (msg.type === 'consumer_left' || msg.type === 'peer_left') {
      const peerId = msg.consumer_id || msg.from_stream || msg.peer_id
      if (peerId && pcs[peerId]) {
        try { pcs[peerId].close() } catch {}
        delete pcs[peerId]
        const i = pendingPeers.indexOf(peerId)
        if (i >= 0) pendingPeers.splice(i, 1)
        log(`Consumer ${peerId} left`, 'info')
      }
    }
  }

  ws.onerror = () => log('Producer signaling error', 'err')
  ws.onclose = () => {
    if (!closed) log('Producer signaling closed', 'warn')
  }

  return {
    getStream: () => currentStream,
    close,
    switchCamera,
    onStreamChange,
    getFacingMode: () => currentFacing,
  }
}
