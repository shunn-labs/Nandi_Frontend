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

// Every vision answer can push a frame, and every spoken announcement an
// audio clip, so both are capped. Only those are ever dropped to make room —
// never a stream, a live audio card or the user's camera preview.
const MAX_FRAME_BOXES = 12
const MAX_AUDIO_BOXES = 6

/** Drops the oldest boxes of `type` beyond `max`, leaving the rest alone. */
function capType(boxes, type, max) {
  let excess = boxes.filter(b => b.type === type).length - max
  if (excess <= 0) return boxes
  return boxes.filter(b => {
    if (b.type !== type || excess <= 0) return true
    excess -= 1
    return false
  })
}

const capFrames = (boxes) => capType(boxes, 'frame', MAX_FRAME_BOXES)
const capAudio = (boxes) => capType(boxes, 'audio', MAX_AUDIO_BOXES)

/** Adds a live audio card for `streamId` unless one is already open. */
function withAudioStream(boxes, id, streamId, label) {
  if (boxes.some(b => b.id === id)) return boxes
  return [...boxes, { id, type: 'audio_stream', label: label || streamId, streamId, at: Date.now() }]
}

/**
 * The media boxes on screen: frames, streams, files and audio the brain shows
 * on this device (show_frame / show_stream / show_file / play_audio /
 * show_audio_stream / close / close_all on the vision-control socket),
 * streams and live audio opened by id, and this device's own camera.
 *
 * A box: { id, type: 'frame' | 'stream' | 'camera' | 'file' | 'audio' | 'audio_stream', label, at, ...media }
 *   frame         imageB64, mime, camera, fileId   (a show_frame for a wid on screen updates it)
 *   file          file {file_id, filename, mime, size, kind}, url (signed download link)
 *   stream        streamId                 (deduped by id)
 *   camera        streamId, producer
 *   audio         url, mime, autoplay, durationS   (a clip from the audio server; deduped by wid,
 *                                                   the 6 most recent are kept)
 *   audio_stream  streamId                 (a live mic on the audio server; deduped by wid)
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
      const { action, wid, label, stream_id, image_b64, mime, camera, file_id } = msg

      if (action === 'show_frame') {
        // `camera`: which camera the frame was taken from, when the brain says.
        // `file_id`: where the brain keeps it (its file store), so it can be saved.
        const image = { imageB64: image_b64, mime: mime || 'image/jpeg', camera: camera || '', fileId: file_id || '' }
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
      } else if (action === 'show_file') {
        // Any non-image file the brain shows here: a card to play or download it.
        const file = msg.file && typeof msg.file === 'object' ? msg.file : {}
        const id = wid || `file_${file.file_id || nextBoxId()}`
        const box = { id, type: 'file', label: label || file.filename || 'File', file, url: msg.url || '', at: Date.now() }
        setBoxes(prev => (prev.some(b => b.id === id) ? prev.map(b => (b.id === id ? { ...box, at: b.at } : b))
          : [...prev, box]))
      } else if (action === 'play_audio' && /^https?:\/\//i.test(msg.url || '')) {
        // A clip from the audio server: a signed URL that needs no auth header.
        const clip = {
          type: 'audio',
          label: label || 'Audio',
          url: msg.url,
          mime: msg.mime || '',
          autoplay: msg.autoplay !== false,
          durationS: Number(msg.duration_s) || 0,
        }
        setBoxes(prev => {
          const existing = wid ? prev.find(b => b.id === wid) : null
          // The same wid again is the same clip: keep the card (and wherever
          // its playback is) rather than restarting or duplicating it.
          if (existing?.type === 'audio') {
            return existing.url === clip.url ? prev : prev.map(b => (b.id === wid ? { ...b, ...clip } : b))
          }
          const id = wid && !existing ? wid : nextBoxId()
          return capAudio([...prev, { id, ...clip, at: Date.now() }])
        })
      } else if (action === 'show_audio_stream' && stream_id) {
        // A live microphone on the audio server, heard over WebRTC.
        const id = wid || `audio_stream_${stream_id}`
        setBoxes(prev => withAudioStream(prev, id, stream_id, label))
      } else if (action === 'show_stream') {
        const id = wid || `stream_${stream_id}`
        setBoxes(prev => (prev.some(b => b.id === id) ? prev
          : [...prev, { id, type: 'stream', label: label || stream_id, streamId: stream_id, at: Date.now() }]))
      } else if (action === 'close' && wid) {
        setBoxes(prev => prev.filter(b => b.id !== wid))
      } else if (action === 'close_all') {
        // Server-initiated, so it only clears what the server put up — audio
        // cards included (they stop and hang up as they unmount). The user's
        // own camera preview stays, and its producer keeps running.
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

  // A live audio card opened from the live audio panel.
  const openAudioStream = useCallback((streamId, label) => {
    if (!streamId) return
    setBoxes(prev => withAudioStream(prev, `audio_stream_${streamId}`, streamId, label))
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
    close, closeAll, openStream, openAudioStream, startCamera, stopCamera, toggleCamera,
  }
}
