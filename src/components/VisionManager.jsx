import React, { useEffect, useState, useCallback, useImperativeHandle, forwardRef, useRef } from 'react'
import VisionBox from './VisionBox.jsx'
import {
  startVisionControl,
  onVisionCommand,
  isVisionControlConnected,
  getMyClientId,
} from '../lib/visionControl.js'
import { startProducer } from '../lib/webrtcConsumer.js'

let _boxIdCounter = 0
const nextBoxId = () => `vbox_${++_boxIdCounter}_${Date.now()}`

/**
 * VisionManager — owns the stack of VisionBox tiles in the right column.
 *
 *  Features:
 *   - Listens for vision-agent commands (show_frame / show_stream / close / close_all)
 *   - Each show_frame creates a NEW box (no replacement) so frames stack up
 *   - Each show_stream is deduped by stream_id (so duplicate calls reuse the same box)
 *   - Manual stream consumer input at the top of the column
 *   - "Close All" button
 *   - Camera button on the input bar triggers a producer (with switch front/back)
 *
 *  Props:
 *   onCaptureToChat(file, label)  – called when a box's 📸 button is hit;
 *                                   `file` is a real File ready to be uploaded
 */
const VisionManager = forwardRef(function VisionManager({ onCaptureToChat }, ref) {
  const [boxes, setBoxes] = useState([])
  const [ctrlConnected, setCtrlConnected] = useState(false)
  const [manualStreamId, setManualStreamId] = useState('')
  // Reported inline in this column. It used to be a native alert(), which
  // blocks the whole page behind a browser-chrome dialog for what is a routine,
  // recoverable condition (permission not granted yet, no camera attached).
  const [cameraError, setCameraError] = useState('')
  const cameraProducerRef = useRef(null)
  const [cameraOn, setCameraOn] = useState(false)

  // ── Vision-control WebSocket ──────────────────────────────
  useEffect(() => {
    startVisionControl()

    const pollId = setInterval(() => {
      setCtrlConnected(isVisionControlConnected())
    }, 1000)

    onVisionCommand((msg) => {
      const { action, wid, label, stream_id, image_b64 } = msg

      if (action === 'show_frame') {
        // ALWAYS create a new box — frames should accumulate, not replace
        setBoxes(prev => [...prev, {
          id: nextBoxId(),
          type: 'frame',
          label: label || 'Frame',
          imageB64: image_b64,
        }])
      }

      else if (action === 'show_stream') {
        const id = wid || `stream_${stream_id}`
        setBoxes(prev => {
          // Dedup streams by id — re-opening the same stream just keeps the existing box
          if (prev.some(b => b.id === id)) return prev
          return [...prev, {
            id,
            type: 'stream',
            label: label || stream_id,
            streamId: stream_id,
          }]
        })
      }

      else if (action === 'close' && wid) {
        setBoxes(prev => prev.filter(b => b.id !== wid))
      }

      else if (action === 'close_all') {
        // Also stop the camera producer if running
        if (cameraProducerRef.current) {
          try { cameraProducerRef.current.close() } catch {}
          cameraProducerRef.current = null
          setCameraOn(false)
        }
        setBoxes([])
      }
    })

    return () => clearInterval(pollId)
  }, [])

  // ── Manual close (per box) ────────────────────────────────
  const handleClose = useCallback((id) => {
    setBoxes(prev => {
      const target = prev.find(b => b.id === id)
      if (target?.type === 'camera' && cameraProducerRef.current) {
        try { cameraProducerRef.current.close() } catch {}
        cameraProducerRef.current = null
        setCameraOn(false)
      }
      return prev.filter(b => b.id !== id)
    })
  }, [])

  // ── Close all (button) ─────────────────────────────────────
  const handleCloseAll = useCallback(() => {
    if (cameraProducerRef.current) {
      try { cameraProducerRef.current.close() } catch {}
      cameraProducerRef.current = null
      setCameraOn(false)
    }
    setBoxes([])
  }, [])

  // ── Capture → chat attachment ──────────────────────────────
  const handleCapture = useCallback((file, label) => {
    onCaptureToChat?.(file, label)
  }, [onCaptureToChat])

  // ── Manual stream input ───────────────────────────────────
  const startManualStream = useCallback(() => {
    const sid = manualStreamId.trim()
    if (!sid) return
    const id = `stream_${sid}`
    setBoxes(prev => {
      if (prev.some(b => b.id === id)) return prev
      return [...prev, {
        id,
        type: 'stream',
        label: sid,
        streamId: sid,
      }]
    })
    setManualStreamId('')
  }, [manualStreamId])

  // ── Camera producer (called from ChatInput camera button) ──
  const startCameraProducer = useCallback(async () => {
    if (cameraProducerRef.current) return

    setCameraError('')
    const clientId = getMyClientId()
    const streamId = `${clientId}_camera`

    try {
      const producer = await startProducer({
        streamId,
        facingMode: 'environment',
        callbacks: {
          onLog: (text, type) => console.log(`[producer] ${text}`, type),
        },
      })
      cameraProducerRef.current = producer

      const boxId = `camera_${streamId}`
      setBoxes(prev => {
        if (prev.some(b => b.id === boxId)) return prev
        return [...prev, {
          id: boxId,
          type: 'camera',
          label: `My Camera · ${streamId}`,
          producer,
        }]
      })
      setCameraOn(true)
    } catch (err) {
      console.error('[vision] camera producer failed:', err)

      const denied =
        err?.name === 'NotAllowedError' || /permission/i.test(err?.message || '')
      const noDevice = err?.name === 'NotFoundError'

      setCameraError(
        denied
          ? 'Camera blocked. Allow camera access for this site, then try again.'
          : noDevice
            ? 'No camera found on this device.'
            : `Camera failed: ${err?.message || 'unknown error'}`
      )
    }
  }, [])

  const stopCameraProducer = useCallback(() => {
    if (cameraProducerRef.current) {
      try { cameraProducerRef.current.close() } catch {}
      cameraProducerRef.current = null
    }
    setBoxes(prev => prev.filter(b => b.type !== 'camera'))
    setCameraOn(false)
  }, [])

  useImperativeHandle(ref, () => ({
    startCameraProducer,
    stopCameraProducer,
    isCameraOn: () => cameraOn,
  }))

  return (
    <div className="vmgr">
      <div className="vmgr__header">
        <span className="vmgr__title">
          <span className={`vmgr__dot${ctrlConnected ? '' : ' vmgr__dot--off'}`} />
          Vision
        </span>
        <div className="vmgr__header-right">
          <span className="vmgr__count">
            {boxes.length > 0 ? `${boxes.length}` : '0'}
          </span>
          {boxes.length > 0 && (
            <button
              className="vmgr__close-all"
              title="Close all boxes"
              onClick={handleCloseAll}
            >
              Close all
            </button>
          )}
        </div>
      </div>

      {/* ── Manual stream consumer ── */}
      <div className="vmgr__manual">
        <input
          type="text"
          className="vmgr__manual-input"
          placeholder="Stream ID (e.g. pc_cam)"
          value={manualStreamId}
          onChange={(e) => setManualStreamId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startManualStream()}
        />
        <button
          className="vmgr__manual-btn"
          onClick={startManualStream}
          disabled={!manualStreamId.trim()}
        >
          ▶
        </button>
      </div>

      {cameraError && (
        <div className="vmgr__error" role="alert">
          {cameraError}
          <button
            className="vmgr__error-dismiss"
            onClick={() => setCameraError('')}
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}

      <div className="vmgr__stack">
        {boxes.length === 0 ? (
          <div className="vmgr__empty">
            No active streams.
            <br />
            <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>
              Type a stream ID above or ask Nandi.
            </span>
          </div>
        ) : (
          boxes.map(box => (
            <VisionBox
              key={box.id}
              box={box}
              onClose={handleClose}
              onCapture={handleCapture}
            />
          ))
        )}
      </div>
    </div>
  )
})

export default VisionManager
