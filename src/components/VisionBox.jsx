import React, { useEffect, useRef, useState } from 'react'
import { startConsumer } from '../lib/webrtcConsumer.js'

/**
 * VisionBox — a single tile in the right column.
 *
 * box.type === 'stream'  → WebRTC consumer with auto-reconnect + manual refresh
 * box.type === 'frame'   → static base64 image
 * box.type === 'camera'  → local producer preview (uses producer ref for switching)
 *
 * Buttons:
 *   📸 Capture  — grab current frame as a File and inject into the chat
 *                 attachment strip (same flow as uploading a file)
 *   🔄 Refresh  — re-connect the WebRTC consumer (stream only)
 *   ⤺  Switch  — flip front ↔ back camera (camera only)
 *   ✕  Close   — close the box
 */
export default function VisionBox({ box, onClose, onCapture }) {
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

    const finalize = (blob) => {
      if (!blob) return
      const safeLabel = (box.label || box.streamId || 'capture')
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
      const filename = `capture_${safeLabel}_${Date.now()}.jpg`
      const file = new File([blob], filename, { type: 'image/jpeg' })
      onCapture?.(file, box.label)
    }

    if (box.type === 'frame') {
      // Re-encode the existing base64 image as a File
      const img = new Image()
      img.onload = () => {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(finalize, 'image/jpeg', 0.92)
      }
      img.src = `data:image/jpeg;base64,${box.imageB64}`
      return
    }

    const video = videoRef.current
    if (!video || !video.videoWidth) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(finalize, 'image/jpeg', 0.92)
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

  const facingLabel = box.type === 'camera' && box.producer
    ? (box.producer.getFacingMode() === 'environment' ? 'back' : 'front')
    : null

  return (
    <div className="vbox">
      <div className="vbox__header">
        <span className="vbox__title">
          <span className={`vbox__dot vbox__dot--${state}`} />
          {box.label || box.streamId || 'Vision'}
          {facingLabel && (
            <span className="vbox__facing">[{facingLabel}]</span>
          )}
        </span>
        <div className="vbox__btns">
          {box.type === 'camera' && (
            <button
              className="vbox__btn"
              title="Switch front / back camera"
              onClick={handleSwitchCamera}
            >
              ⤺
            </button>
          )}
          {box.type === 'stream' && (
            <button
              className="vbox__btn"
              title="Refresh / reconnect"
              onClick={handleRefresh}
            >
              🔄
            </button>
          )}
          <button
            className="vbox__btn"
            title="Capture frame → attach to chat"
            onClick={handleCapture}
          >
            📸
          </button>
          <button
            className="vbox__btn vbox__btn--close"
            title="Close"
            onClick={() => onClose?.(box.id)}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="vbox__body">
        {box.type === 'frame' ? (
          <img
            className="vbox__media"
            src={`data:image/jpeg;base64,${box.imageB64}`}
            alt={box.label}
          />
        ) : (
          <video
            ref={videoRef}
            className="vbox__media"
            autoPlay
            playsInline
            muted
          />
        )}
        {state !== 'live' && box.type === 'stream' && (
          <div className="vbox__placeholder">
            {state === 'connecting' && 'Connecting…'}
            {state === 'waiting' && 'No producer on this stream yet · waiting…'}
            {state === 'offline' && 'Producer offline · auto-retrying…'}
            {state === 'failed' && 'Connection failed · retrying…'}
          </div>
        )}
      </div>
    </div>
  )
}
