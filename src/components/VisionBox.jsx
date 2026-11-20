import React, { useEffect, useRef, useState } from 'react'
import { startConsumer } from '../lib/webrtcConsumer.js'

/**
 * VisionBox — the picture inside a vision panel on the stage. The panel around
 * it carries the title and Close; this draws the media and its own tools.
 *
 * box.type === 'stream'  → WebRTC consumer with auto-reconnect + manual refresh
 * box.type === 'frame'   → static base64 image (box.mime, JPEG if unset)
 * box.type === 'camera'  → local producer preview (uses producer ref for switching)
 *
 * Buttons:
 *   📸 Capture  — grab current frame as a File and inject into the chat
 *                 attachment strip (same flow as uploading a file)
 *   🔄 Refresh  — re-connect the WebRTC consumer (stream only)
 *   ⤺  Switch  — flip front ↔ back camera (camera only)
 *   (Closing is the panel's job.)
 *
 * onAspect(width / height) reports the media's real shape once it is known
 * (and again if a stream changes resolution), so the panel can take that
 * shape instead of letterboxing the picture.
 */
export default function VisionBox({ box, onCapture, onAspect }) {
  const videoRef = useRef(null)
  const consumerRef = useRef(null)
  const [state, setState] = useState(box.type === 'frame' ? 'live' : 'connecting')
  const [, forceRender] = useState(0)

  // ── Stream mode: start consumer with auto-reconnect ──────
  useEffect(() => {
    if (box.type !== 'stream') return

    consumerRef.current = startConsumer(box.streamId, {
      onTrack: (mediaStream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream
          setState('live')
        }
      },
      onState: (s) => {
        if (s === 'offline' || s === 'failed' || s === 'disconnected') {
          setState('offline')
        } else if (s === 'connected') {
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

    const video = videoRef.current
    if (!video || !video.videoWidth) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(finalize, outType, 0.92)
  }

  // ── Refresh stream consumer ──
  // Don't set state here. If the stream is already healthy, refresh() is a
  // no-op and would otherwise leave the box stuck on "Connecting…". The
  // consumer reports state changes through onState above.
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

  const reportAspect = (w, h) => {
    if (w > 0 && h > 0) onAspect?.(w / h)
  }

  const facingLabel = box.type === 'camera' && box.producer
    ? (box.producer.getFacingMode() === 'environment' ? 'back' : 'front')
    : null

  return (
    <div className="vbox">
      {box.type === 'frame' ? (
        <img
          className="vbox__media"
          src={`data:${box.mime || 'image/jpeg'};base64,${box.imageB64}`}
          alt={box.label}
          onLoad={(e) => reportAspect(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        />
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

      <div className="vbox__tools">
        {box.type === 'camera' && (
          <button className="vbox__tool" title="Switch front / back camera" onClick={handleSwitchCamera}>Switch</button>
        )}
        {box.type === 'stream' && (
          <button className="vbox__tool" title="Reconnect" onClick={handleRefresh}>Reconnect</button>
        )}
        <button className="vbox__tool" title="Attach this frame to your next message" onClick={handleCapture}>Attach</button>
      </div>

      {state !== 'live' && box.type === 'stream' && (
        <div className="vbox__placeholder">
          {state === 'connecting' && 'Connecting…'}
          {state === 'waiting' && 'No producer on this stream yet · waiting…'}
          {state === 'offline' && 'Producer offline · auto-retrying…'}
          {state === 'failed' && 'Connection failed · retrying…'}
        </div>
      )}
    </div>
  )
}
