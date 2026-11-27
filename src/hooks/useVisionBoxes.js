import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  startVisionControl,
  onVisionCommand,
  isVisionControlConnected,
  getVisionControlError,
  getMyClientId,
} from '../lib/visionControl.js'
import { startFrameProducer } from '../lib/visionFrames.js'
import { getMediaConfig, publishCamera } from '../lib/mediaHub.js'
import { absoluteUrl } from '../lib/filesApi.js'

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

// What the audio server's speak tool labels a clip in Nandi's own voice.
const NANDI_VOICE_LABEL = 'Nandi'

/**
 * The media boxes on screen: frames, streams, files and audio the brain shows
 * on this device (show_frame / show_stream / show_file / play_audio /
 * show_audio_stream / close / close_all on the vision-control socket),
 * streams and live audio opened by id, and this device's own camera.
 *
 * A box: { id, type: 'frame' | 'stream' | 'camera' | 'file' | 'audio' | 'audio_stream', label, at, ...media }
 *   frame         imageB64, mime, camera, fileId   (a show_frame for a wid on screen updates it)
 *   file          file {file_id, filename, mime, size, kind}, url (signed download link),
 *                 preview {format, text, truncated} (a docx/xlsx/text preview, when the brain sends one)
 *   stream        streamId                 (deduped by id)
 *   camera        streamId, producer
 *   audio         url, mime, autoplay, durationS, voice   (a clip from the audio server; deduped by
 *                                                   wid, the 6 most recent are kept; `voice`: it is
 *                                                   Nandi speaking, so interrupting her stops it)
 *   audio_stream  streamId                 (a live mic on the audio server; deduped by wid)
 *
 * focusRequest { id, n }: the brain showed again a live mic (or stream) that is
 * already open — the screen brings that window to the front.
 */
export default function useVisionBoxes() {
  const [boxes, setBoxes] = useState([])
  const [ctrlConnected, setCtrlConnected] = useState(false)
  // Why the server refused this browser's vision-control registration, if it did.
  const [ctrlError, setCtrlError] = useState('')
  const [cameraError, setCameraError] = useState('')
  const [cameraOn, setCameraOn] = useState(false)
  // How this device's camera reaches the vision server: { path: 'hub' | 'jpeg',
  // reason (why not the hub), failed (the hub was offered but unusable from
  // here), width, height, fps (what the camera delivers) }.
  const [cameraPath, setCameraPath] = useState(null)
  const [focusRequest, setFocusRequest] = useState(null)
  const producerRef = useRef(null)
  const boxesRef = useRef(boxes)
  boxesRef.current = boxes
  const askFocus = (id) => setFocusRequest(r => ({ id, n: (r?.n || 0) + 1 }))

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
        // A file from Nandi's file store (an image over the inline size, a
        // PDF, a document, a video…): a window that shows it.
        const file = msg.file && typeof msg.file === 'object' ? msg.file : {}
        const id = wid || `file_${file.file_id || nextBoxId()}`
        const preview = msg.preview && typeof msg.preview === 'object' ? msg.preview : null
        const box = { id, type: 'file', label: label || file.filename || 'File', file, url: msg.url || '', preview, at: Date.now() }
        setBoxes(prev => {
          const existing = prev.find(b => b.id === id)
          if (!existing) return [...prev, box]
          // The same file shown again comes with a freshly signed link. Swapping
          // it in would reload a playing video or a PDF from the start (the
          // window "blinks"), so the window keeps its link and its place.
          const same = existing.type === 'file' && existing.file?.file_id && existing.file.file_id === file.file_id
          return prev.map(b => (b.id !== id ? b
            : same ? { ...b, label: box.label, file: { ...b.file, ...file }, preview: preview || b.preview }
            : { ...box, at: b.at }))
        })
      } else if (action === 'play_audio' && /^https?:\/\//i.test(absoluteUrl(msg.url || ''))) {
        // A clip from the audio server, or a voice note from Nandi's files: a
        // signed URL that needs no auth header. The brain's own links are
        // relative (/f/<token>), so they are made absolute first — they used to
        // be dropped here.
        const clip = {
          type: 'audio',
          label: label || 'Audio',
          url: absoluteUrl(msg.url),
          mime: msg.mime || '',
          autoplay: msg.autoplay !== false,
          durationS: Number(msg.duration_s) || 0,
          voice: (label || '') === NANDI_VOICE_LABEL,
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
        if (boxesRef.current.some(b => b.id === id)) askFocus(id)
        setBoxes(prev => withAudioStream(prev, id, stream_id, label))
      } else if (action === 'show_stream') {
        const id = wid || `stream_${stream_id}`
        if (boxesRef.current.some(b => b.id === id)) askFocus(id)
        setBoxes(prev => (prev.some(b => b.id === id) ? prev
          : [...prev, { id, type: 'stream', label: label || stream_id, streamId: stream_id, at: Date.now() }]))
      } else if (action === 'close' && (wid || file_id)) {
        // By window id, or by file: "close that photo" closes every window
        // showing that file (a frame from a tool, or the file itself).
        setBoxes(prev => prev.filter(b => !(
          (wid && b.id === wid)
          || (file_id && (b.fileId === file_id || b.file?.file_id === file_id))
        )))
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
    setCameraPath(null)
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

  // A live audio card opened from the live audio panel (one already open is
  // brought to the front).
  const openAudioStream = useCallback((streamId, label) => {
    if (!streamId) return
    const id = `audio_stream_${streamId}`
    if (boxesRef.current.some(b => b.id === id)) askFocus(id)
    setBoxes(prev => withAudioStream(prev, id, streamId, label))
  }, [])

  const startCamera = useCallback(async () => {
    if (producerRef.current) return
    setCameraError('')
    const streamId = `${getMyClientId()}_camera`
    try {
      const opts = {
        streamId,
        facingMode: 'environment',
        callbacks: { onLog: (text, type) => console.log(`[producer] ${text}`, type) },
      }
      // The media hub (WebRTC, the camera's own quality) when the vision server
      // offers it; otherwise, or if this network can't reach it, JPEG frames —
      // telling the server why, so the fallback is visible there too.
      let producer = null
      let reason = ''
      if ((await getMediaConfig(true)).usable) {
        try {
          producer = await publishCamera(opts)
        } catch (err) {
          if (err?.name === 'NotAllowedError' || err?.name === 'NotFoundError') throw err
          reason = err?.message || String(err) || 'publish failed'
          console.warn('[vision] media hub publish failed, using JPEG frames:', err)
        }
      }
      if (!producer) producer = await startFrameProducer({ ...opts, fallback: reason })
      producerRef.current = producer
      const s = producer.getStream()?.getVideoTracks?.()[0]?.getSettings?.() || {}
      setCameraPath({
        path: producer.path || (producer.transport === 'webrtc' ? 'hub' : 'jpeg'),
        reason: producer.path === 'hub' ? '' : (reason || 'the vision server has no media hub'),
        failed: Boolean(reason),            // the hub was offered but could not be used
        width: s.width || 0, height: s.height || 0, fps: Math.round(s.frameRate || 0),
      })
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

  const clearCameraError = useCallback(() => setCameraError(''), [])

  // One object per change of what it holds, not per render: callers put its
  // functions in their own useCallback / useMemo deps, and a fresh object
  // every render rebuilt them all (and everything that depended on them).
  return useMemo(() => ({
    boxes, ctrlConnected, ctrlError, cameraError, cameraOn, cameraPath, clearCameraError, focusRequest,
    close, closeAll, openStream, openAudioStream, startCamera, stopCamera, toggleCamera,
  }), [boxes, ctrlConnected, ctrlError, cameraError, cameraOn, cameraPath, clearCameraError, focusRequest,
    close, closeAll, openStream, openAudioStream, startCamera, stopCamera, toggleCamera])
}
