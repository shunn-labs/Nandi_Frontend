import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startVisionControl,
  onVisionCommand,
  isVisionControlConnected,
  getVisionControlError,
  getMyClientId,
} from '../lib/visionControl.js'
import { startProducer } from '../lib/webrtcConsumer.js'

let boxCounter = 0
const nextBoxId = () => `vbox_${++boxCounter}_${Date.now()}`

// Every vision answer can push a frame, so frames are capped. Only frames are
// ever dropped to make room — never a stream or the user's camera preview.
const MAX_FRAME_BOXES = 12

/** Drops the oldest frame boxes beyond MAX_FRAME_BOXES, leaving the rest alone. */
function capFrames(boxes) {
  let excess = boxes.filter(b => b.type === 'frame').length - MAX_FRAME_BOXES
  if (excess <= 0) return boxes
  return boxes.filter(b => {
    if (b.type !== 'frame' || excess <= 0) return true
    excess -= 1
    return false
  })
}

/**
 * The vision boxes on screen: frames and streams the brain shows on this
 * device (show_frame / show_stream / close / close_all on the vision-control
 * socket), streams opened by id, and this device's own camera.
 *
 * A box: { id, type: 'frame' | 'stream' | 'camera', label, at, ...media }
 *   frame   imageB64, mime, camera   (a show_frame for a wid on screen updates it)
 *   stream  streamId                 (deduped by id)
 *   camera  streamId, producer
 */
export default function useVisionBoxes() {
  const [boxes, setBoxes] = useState([])
  const [ctrlConnected, setCtrlConnected] = useState(false)
  // Why the server refused this browser's vision-control registration, if it did.
  const [ctrlError, setCtrlError] = useState('')
  const [cameraError, setCameraError] = useState('')
  const [cameraOn, setCameraOn] = useState(false)
  const producerRef = useRef(null)

  // ── Vision-control socket ──────────────────────────────
  useEffect(() => {
    startVisionControl()
    const pollId = setInterval(() => {
      setCtrlConnected(isVisionControlConnected())
      setCtrlError(getVisionControlError())
    }, 1000)

    onVisionCommand((msg) => {
      const { action, wid, label, stream_id, image_b64, mime, camera } = msg

      if (action === 'show_frame') {
        // `camera`: which camera the frame was taken from, when the brain says.
        const image = { imageB64: image_b64, mime: mime || 'image/jpeg', camera: camera || '' }
        setBoxes(prev => {
          // The server re-sends a wid to refresh that box, so update it in place.
          const existing = wid ? prev.find(b => b.id === wid) : null
          if (existing?.type === 'frame') {
            return prev.map(b => (b.id === wid ? { ...b, ...image, label: label || b.label } : b))
          }
          // A wid already taken by a stream or camera box would collide as a
          // React key, so that frame gets an id of its own.
          const id = wid && !existing ? wid : nextBoxId()
          return capFrames([...prev, { id, type: 'frame', label: label || 'Frame', at: Date.now(), ...image }])
        })
      } else if (action === 'show_stream') {
        const id = wid || `stream_${stream_id}`
        setBoxes(prev => (prev.some(b => b.id === id) ? prev
          : [...prev, { id, type: 'stream', label: label || stream_id, streamId: stream_id, at: Date.now() }]))
      } else if (action === 'close' && wid) {
        setBoxes(prev => prev.filter(b => b.id !== wid))
      } else if (action === 'close_all') {
        // Server-initiated, so it only clears what the server put up. The
        // user's own camera preview stays, and its producer keeps running.
        setBoxes(prev => prev.filter(b => b.type === 'camera'))
      }
    })

    return () => clearInterval(pollId)
  }, [])

  const releaseCamera = () => {
    if (producerRef.current) {
      try { producerRef.current.close() } catch { /* already closed */ }
      producerRef.current = null
    }
    setCameraOn(false)
  }

  const close = useCallback((id) => {
    setBoxes(prev => {
      if (prev.find(b => b.id === id)?.type === 'camera') releaseCamera()
      return prev.filter(b => b.id !== id)
    })
  }, [])

  const closeAll = useCallback(() => {
    releaseCamera()
    setBoxes([])
  }, [])

  const openStream = useCallback((streamId, label) => {
    const id = `stream_${streamId}`
    setBoxes(prev => (prev.some(b => b.id === id) ? prev
      : [...prev, { id, type: 'stream', label: label || streamId, streamId, at: Date.now() }]))
  }, [])

  const startCamera = useCallback(async () => {
    if (producerRef.current) return
    setCameraError('')
    const streamId = `${getMyClientId()}_camera`
    try {
      const producer = await startProducer({
        streamId,
        facingMode: 'environment',
        callbacks: { onLog: (text, type) => console.log(`[producer] ${text}`, type) },
      })
      producerRef.current = producer
      const id = `camera_${streamId}`
      setBoxes(prev => (prev.some(b => b.id === id) ? prev
        : [...prev, { id, type: 'camera', label: 'My camera', streamId, producer, at: Date.now() }]))
      setCameraOn(true)
    } catch (err) {
      console.error('[vision] camera producer failed:', err)
      const denied = err?.name === 'NotAllowedError' || /permission/i.test(err?.message || '')
      setCameraError(denied ? 'Camera blocked. Allow camera access for this site, then try again.'
        : err?.name === 'NotFoundError' ? 'No camera found on this device.'
        : `Camera failed: ${err?.message || 'unknown error'}`)
    }
  }, [])

  const stopCamera = useCallback(() => {
    releaseCamera()
    setBoxes(prev => prev.filter(b => b.type !== 'camera'))
  }, [])

  const toggleCamera = useCallback(() => {
    if (producerRef.current) stopCamera()
    else startCamera()
  }, [startCamera, stopCamera])

  return {
    boxes, ctrlConnected, ctrlError, cameraError, cameraOn,
    clearCameraError: useCallback(() => setCameraError(''), []),
    close, closeAll, openStream, startCamera, stopCamera, toggleCamera,
  }
}
