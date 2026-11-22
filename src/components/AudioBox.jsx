import React, { useEffect, useRef, useState } from 'react'
import { listen, listStreams } from '../lib/audioStreams.js'

// How often a live card re-checks whether the mic behind it is on air.
const STREAM_POLL_MS = 5000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 15000

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// The card around the content carries the title and Close; this is the status
// line inside it.
function Status({ dot, children, error = false }) {
  return (
    <span className={`abox__status${error ? ' abox__status--error' : ''}`} role="status">
      <span className={`abox__dot abox__dot--${dot}`} aria-hidden="true" />
      {children}
    </span>
  )
}

/**
 * A clip the brain sent (play_audio): Nandi speaking, a recording from a mic.
 * The URL is signed and needs no auth header, so the element plays it
 * directly. Browsers may refuse to autoplay sound; the controls stay usable
 * either way and the card says so.
 */
function AudioClipBox({ box }) {
  const audioRef = useRef(null)
  const [status, setStatus] = useState('ready')     // ready | playing | blocked | error

  useEffect(() => {
    setStatus('ready')
    const el = audioRef.current
    if (!el || !box.autoplay) return
    // The autoPlay attribute fails silently when blocked; play() says so.
    el.play?.()?.catch?.((err) => {
      if (err?.name === 'NotAllowedError') setStatus('blocked')
    })
  }, [box.url, box.autoplay])

  // Unmounting removes the element, which pauses it — but say it explicitly.
  useEffect(() => {
    const el = audioRef.current
    return () => { try { el?.pause() } catch {} }
  }, [])

  const dot = status === 'playing' ? 'live' : status === 'error' ? 'failed' : 'idle'
  let text = status === 'playing' ? 'Playing' : 'Ready'
  if (status === 'blocked') text = 'Autoplay was blocked — press ▶ to listen.'
  if (status === 'error') text = 'This clip could not be loaded — its link may have expired.'

  return (
    <div className="abox">
      <audio
        ref={audioRef}
        className="abox__player"
        src={box.url}
        controls
        autoPlay={!!box.autoplay}
        preload="auto"
        onPlay={() => setStatus('playing')}
        onPause={() => setStatus(s => (s === 'error' ? s : 'ready'))}
        onEnded={() => setStatus('ready')}
        onError={() => setStatus('error')}
      />
      <div className="abox__meta">
        <Status dot={dot} error={status === 'error'}>{text}</Status>
        {status !== 'error' && box.durationS > 0 && <span>{formatDuration(box.durationS)}</span>}
      </div>
    </div>
  )
}

/**
 * A live microphone (show_audio_stream, or Listen in the live audio
 * panel), heard over WebRTC from the audio server. Shows whether the mic is
 * on air (polled from GET /v1/streams) and lets the listener stop and start
 * again; a dropped connection is retried with backoff. Closing the card
 * closes the peer connection and DELETEs the server session.
 */
function AudioStreamBox({ box }) {
  const audioRef = useRef(null)
  const [listening, setListening] = useState(true)
  const [conn, setConn] = useState('connecting')   // connecting | live | disconnected | failed | closed | error
  const [error, setError] = useState(null)         // { message, retryable }
  const [blocked, setBlocked] = useState(false)
  const [onAir, setOnAir] = useState(null)         // is the mic publishing? null = unknown
  const [attempt, setAttempt] = useState(0)        // bumped to reconnect
  const retriesRef = useRef(0)

  // ── the WebRTC listen session ──
  useEffect(() => {
    if (!listening) return
    const ctrl = new AbortController()
    let handle = null
    setConn('connecting')
    setError(null)
    setBlocked(false)

    listen(box.streamId, {
      audioEl: audioRef.current,
      signal: ctrl.signal,
      onState: (s) => {
        if (ctrl.signal.aborted) return
        if (s === 'blocked') { setBlocked(true); return }
        if (s === 'live') retriesRef.current = 0
        setConn(s)
      },
    })
      .then((h) => { handle = h })
      .catch((err) => {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return
        setConn('error')
        setError({
          message: err?.userMessage || err?.message || 'Could not connect to the stream.',
          retryable: !err?.status || err.status >= 500,
        })
      })

    return () => {
      ctrl.abort()
      handle?.stop()
    }
  }, [box.streamId, listening, attempt])

  // ── reconnect after a drop or a transient failure ──
  useEffect(() => {
    if (!listening) return
    const dropped = conn === 'failed' || conn === 'closed' || conn === 'disconnected'
    if (!dropped && !(conn === 'error' && error?.retryable)) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** retriesRef.current, RETRY_MAX_MS)
    const timer = setTimeout(() => {
      retriesRef.current += 1
      setAttempt(a => a + 1)
    }, delay)
    return () => clearTimeout(timer)
  }, [conn, error, listening])

  // ── is the mic on air? ──
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const streams = await listStreams()
        if (cancelled) return
        const s = streams.find(x => x.id === box.streamId)
        setOnAir(s ? !!s.live : false)
      } catch {
        if (!cancelled) setOnAir(null)
      }
    }
    poll()
    const id = setInterval(poll, STREAM_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [box.streamId])

  let dot = 'connecting'
  let status = 'Connecting…'
  if (!listening) {
    dot = 'idle'
    status = 'Stopped'
  } else if (conn === 'error') {
    dot = 'failed'
    status = error?.message || 'Could not connect.'
    if (error?.retryable) status += ' Retrying…'
  } else if (conn === 'failed' || conn === 'closed' || conn === 'disconnected') {
    dot = 'offline'
    status = 'Connection lost · reconnecting…'
  } else if (conn === 'live') {
    dot = onAir === false ? 'waiting' : 'live'
    status = onAir === false ? 'Mic offline · waiting for it to come back' : 'Live'
  }

  const toggle = () => {
    retriesRef.current = 0
    setListening(v => !v)
  }

  return (
    <div className="abox">
      <audio ref={audioRef} className="abox__player" controls autoPlay playsInline />
      <div className="abox__meta">
        <Status dot={dot} error={conn === 'error' && listening}>{status}</Status>
        <button className="devices__btn" onClick={toggle} title={listening ? 'Stop listening' : 'Listen again'}>
          {listening ? 'Stop' : 'Listen'}
        </button>
      </div>
      {blocked && listening && (
        <div className="abox__meta">Your browser blocked autoplay — press ▶ to hear it.</div>
      )}
    </div>
  )
}

/**
 * AudioBox — the content of an audio card on the stage (the card carries the
 * title and Close; closing unmounts this, which stops playback and hangs up).
 *
 * box.type === 'audio'         { url, mime, label, autoplay, durationS }  (play_audio)
 * box.type === 'audio_stream'  { streamId, label }                        (show_audio_stream)
 */
export default function AudioBox({ box }) {
  return box.type === 'audio_stream'
    ? <AudioStreamBox box={box} />
    : <AudioClipBox box={box} />
}
