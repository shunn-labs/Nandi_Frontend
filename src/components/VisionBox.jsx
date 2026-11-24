import React, { memo, useEffect, useRef, useState } from 'react'
import { startFrameConsumer } from '../lib/visionFrames.js'
import { downloadFile } from '../lib/filesApi.js'
import AudioBox from './AudioBox.jsx'
import FileViewer from './FileViewer.jsx'

/**
 * VisionBox — the picture inside a vision panel on the stage. The panel around
 * it carries the title and Close; this draws the media and its own tools.
 *
 * box.type === 'stream'  → live view: JPEG frames over WebSocket drawn on a
 *                          canvas (visionFrames.js), auto-reconnect + manual refresh
 * box.type === 'frame'   → static base64 image (box.mime, JPEG if unset)
 * box.type === 'camera'  → local producer preview (uses producer ref for switching)
 * box.type === 'file'    → a file from Nandi's file store (FileViewer: picture, video,
 *                          PDF, text, table, document preview…)
 * box.type === 'audio'         → a clip from the audio server (AudioBox)
 * box.type === 'audio_stream'  → a live mic from the audio server (AudioBox)
 *
 * Buttons:
 *   📸 Capture  — grab current frame as a File and inject into the chat
 *                 attachment strip (same flow as uploading a file)
 *   🔄 Refresh  — re-connect the live view (stream only)
 *   ⤺  Switch  — flip front ↔ back camera (camera only)
 *   ⤓  Save    — download the frame from Nandi's files (frames the brain stored)
 *   (Closing is the panel's job.)
 *
 * onAspect(boxId, width / height) reports the media's real shape once it is
 * known (and again if a stream changes resolution), so the window can take
 * that shape instead of letterboxing the picture. It takes the box id, so the
 * parent can pass one stable function for every box (memo stays effective).
 */
function VisionBox({ box, onCapture, onAspect }) {
  const aspect = (r) => onAspect?.(box.id, r)
  if (box.type === 'file') return <FileViewer box={box} onAspect={aspect} />
  // Audio has nothing to capture and no picture, so it is its own component
  // rather than more branches in MediaBox (and its hooks).
  if (box.type === 'audio' || box.type === 'audio_stream') return <AudioBox box={box} />
  return <MediaBox box={box} onCapture={onCapture} onAspect={aspect} />
}

export default memo(VisionBox)

function MediaBox({ box, onCapture, onAspect }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const consumerRef = useRef(null)
  const [state, setState] = useState(box.type === 'frame' ? 'live' : 'connecting')
  const [, forceRender] = useState(0)

  // ── Stream mode: start the frame consumer with auto-reconnect ──
  useEffect(() => {
    if (box.type !== 'stream') return

    let lastSize = ''
    consumerRef.current = startFrameConsumer(box.streamId, {
      onFrame: (image) => {
        const canvas = canvasRef.current
        if (!canvas) { image.close?.(); return }
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width
          canvas.height = image.height
        }
        canvas.getContext('2d').drawImage(image, 0, 0)
        image.close?.()
        const size = `${image.width}x${image.height}`
        if (size !== lastSize) {
          lastSize = size
          reportAspect(image.width, image.height)
        }
      },
      onState: (s) => {
        if (s === 'offline' || s === 'failed' || s === 'disconnected') {
          setState('offline')
        } else if (s === 'live' || s === 'connected') {
          setState('live')
        } else if (s === 'waiting') {
          // The signalling server has told us there is no producer on this
          // stream id. Folding that into 'connecting' made a stream that does
          // not exist — a typo in the box above, a camera that was never
          // started — look exactly like one that is about to come up, forever.
          setState('waiting')
        } else if (s === 'connecting') {
          setState('connecting')
        }
      },
    })

    return () => consumerRef.current?.close()
  }, [box.type, box.streamId])

  // ── Camera mode: attach local stream and react to switches ──
  useEffect(() => {
    if (box.type !== 'camera') return

    // Initial attach
    if (videoRef.current && box.producer) {
      videoRef.current.srcObject = box.producer.getStream()
      setState('live')

      // Listen for camera-switch stream changes
      const unsubscribe = box.producer.onStreamChange((newStream) => {
        if (videoRef.current) videoRef.current.srcObject = newStream
        forceRender(n => n + 1) // refresh facingMode label
      })

      return unsubscribe
    }
  }, [box.type, box.producer])

  // ── Capture: produce a File and inject into chat attachments ──
  const handleCapture = () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')

    // Captures are JPEG, except that a PNG frame stays PNG: re-encoding it
    // would blur sharp overlays and turn any transparency black.
    const outType = box.type === 'frame' && box.mime === 'image/png' ? 'image/png' : 'image/jpeg'

    const finalize = (blob) => {
      if (!blob) return
      const safeLabel = (box.label || box.streamId || 'capture')
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
      const ext = outType === 'image/png' ? 'png' : 'jpg'
      const filename = `capture_${safeLabel}_${Date.now()}.${ext}`
      const file = new File([blob], filename, { type: outType })
      onCapture?.(file, box.label)
    }

    if (box.type === 'frame') {
      // Re-encode the existing base64 image as a File
      const img = new Image()
      img.onload = () => {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(finalize, outType, 0.92)
      }
      img.src = `data:${box.mime || 'image/jpeg'};base64,${box.imageB64}`
      return
    }

    if (box.type === 'stream') {
      // The JPEG exactly as the server sent it — no second encode.
      const last = consumerRef.current?.getLastFrame?.()
      if (last?.blob) { finalize(last.blob); return }
      const shown = canvasRef.current
      if (!shown || !shown.width) return
      shown.toBlob(finalize, outType, 0.92)
      return
    }

    const video = videoRef.current
    if (!video || !video.videoWidth) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(finalize, outType, 0.92)
  }

  // ── Refresh stream consumer ──
  // Don't set state here: the consumer reports 'connecting' and then 'live'
  // (once a frame is drawn) through onState above.
  const handleRefresh = () => {
    consumerRef.current?.refresh?.()
  }

  // ── Switch camera (camera type only) ──
  const handleSwitchCamera = async () => {
    if (!box.producer) return
    try {
      await box.producer.switchCamera()
    } catch (err) {
      alert(`Camera switch failed: ${err.message}`)
    }
  }

  const [saveError, setSaveError] = useState('')
  const handleSave = async () => {
    setSaveError('')
    try {
      const ext = box.mime === 'image/png' ? 'png' : 'jpg'
      await downloadFile(box.fileId, `${(box.label || 'frame').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.${ext}`)
    } catch (err) {
      setSaveError(err.message)
    }
  }

  const reportAspect = (w, h) => {
    if (w > 0 && h > 0) onAspect?.(w / h)
  }

  // Rebuilt only when the frame changes, not on every render of the window.
  const frameSrc = React.useMemo(
    () => (box.type === 'frame' ? `data:${box.mime || 'image/jpeg'};base64,${box.imageB64}` : ''),
    [box.type, box.mime, box.imageB64])

  const facingLabel = box.type === 'camera' && box.producer
    ? (box.producer.getFacingMode() === 'environment' ? 'back' : 'front')
    : null

  return (
    <div className="vbox">
      {box.type === 'frame' ? (
        <img
          className="vbox__media"
          src={frameSrc}
          alt={box.label}
          draggable={false}
          onLoad={(e) => reportAspect(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        />
      ) : box.type === 'stream' ? (
        <canvas ref={canvasRef} className="vbox__media" />
      ) : (
        <video
          ref={videoRef}
          className="vbox__media"
          autoPlay
          playsInline
          muted
          onLoadedMetadata={(e) => reportAspect(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          onResize={(e) => reportAspect(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
        />
      )}

      {box.type !== 'frame' && (
        <span className={`vbox__state vbox__state--${state}`}>
          {state === 'live' ? (box.type === 'camera' ? `LIVE · ${facingLabel}` : 'LIVE') : state}
        </span>
      )}

      {/* Where the picture comes from, on the picture itself (like a CCTV overlay). */}
      {(box.streamId || box.camera) && (
        <span className="vbox__id" title="Stream ID">{box.streamId || box.camera}</span>
      )}

      <div className="vbox__tools">
        {box.type === 'camera' && (
          <button className="vbox__tool" title="Switch front / back camera" onClick={handleSwitchCamera}>Switch</button>
        )}
        {box.type === 'stream' && (
          <button className="vbox__tool" title="Reconnect" onClick={handleRefresh}>Reconnect</button>
        )}
        {box.type === 'frame' && box.fileId && (
          <button className="vbox__tool" title={saveError || 'Download this frame'} onClick={handleSave}>
            {saveError ? 'Save failed' : 'Save'}
          </button>
        )}
        <button className="vbox__tool" title="Attach this frame to your next message" onClick={handleCapture}>Attach</button>
      </div>

      {state !== 'live' && box.type === 'stream' && (
        <div className="vbox__placeholder">
          {state === 'connecting' && 'Connecting…'}
          {state === 'waiting' && 'No producer on this stream yet · waiting…'}
          {state === 'offline' && 'No frames · auto-retrying…'}
          {state === 'failed' && 'Connection failed · retrying…'}
        </div>
      )}
    </div>
  )
}
