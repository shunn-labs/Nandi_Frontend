import React, { useEffect, useRef, useState } from 'react'
import { listen, listStreams } from '../lib/audioStreams.js'
import { registerSpeechPlayer } from '../lib/speechBus.js'

// How often a live card re-checks whether the mic behind it is on air.
const STREAM_POLL_MS = 5000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 15000
// While a mic is not there (404) or off air, the listen is retried this often.
const WAIT_RETRY_MS = 4000
// Level meter: how much a level is amplified for the bar, and how fast the bar
// falls back (per frame) so it reads as a meter rather than flickering.
const LEVEL_GAIN = 4
const LEVEL_FALL = 0.06

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
 *
 * A clip in Nandi's own voice (box.voice) is registered with the speech bus:
 * interrupting Nandi (globe, Space, Esc, the mic) pauses it, and the globe
 * shows her speaking while it plays.
 */
function AudioClipBox({ box }) {
  const audioRef = useRef(null)
  const [status, setStatus] = useState('ready')     // ready | playing | blocked | error
  const speechRef = useRef(null)

  useEffect(() => {
    if (!box.voice) return undefined
    const handle = registerSpeechPlayer(() => { try { audioRef.current?.pause() } catch {} })
    speechRef.current = handle
    return () => {
      speechRef.current = null
      handle.unregister()
    }
  }, [box.voice])

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

  const talking = (on) => speechRef.current?.setPlaying(on)

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
        onPlay={() => { setStatus('playing'); talking(true) }}
        onPause={() => { setStatus(s => (s === 'error' ? s : 'ready')); talking(false) }}
        onEnded={() => { setStatus('ready'); talking(false) }}
        onError={() => { setStatus('error'); talking(false) }}
      />
      <div className="abox__meta">
        <Status dot={dot} error={status === 'error'}>{text}</Status>
        {status !== 'error' && box.durationS > 0 && <span>{formatDuration(box.durationS)}</span>}
      </div>
    </div>
  )
}

/**
 * The live level of what an <audio> element receives over WebRTC, drawn into
 * `fillRef` (a bar) without re-rendering. The analyser reads the element's
 * MediaStream, not the element, so playback itself is untouched. Returns
 * resume(), to call from a tap when the browser kept the meter's context
 * suspended.
 */
function useLevelMeter(audioRef, fillRef, active) {
  const ctxRef = useRef(null)

  useEffect(() => {
    if (!active) return undefined
    const el = audioRef.current
    const stream = el?.srcObject
    const AC = window.AudioContext || window.webkitAudioContext
    if (!stream || !AC || !stream.getAudioTracks?.().length) return undefined

    let ctx
    try {
      ctx = new AC()
    } catch {
      return undefined
    }
    ctxRef.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    let source
    try {
      source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)
    } catch (err) {
      console.warn('[audio] level meter unavailable:', err)
      ctx.close?.().catch?.(() => {})
      return undefined
    }
    ctx.resume?.().catch(() => {})
    const data = new Uint8Array(analyser.fftSize)
    let shown = 0
    let raf = 0
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * LEVEL_GAIN)
      shown = level > shown ? level : Math.max(level, shown - LEVEL_FALL)
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${shown.toFixed(3)})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      try { source.disconnect() } catch {}
      ctx.close?.().catch?.(() => {})
      ctxRef.current = null
      if (fillRef.current) fillRef.current.style.transform = 'scaleX(0)'
    }
  }, [audioRef, fillRef, active])

  return () => ctxRef.current?.resume?.().catch(() => {})
}

/**
 * A live microphone (show_audio_stream, or Listen in the live audio panel),
 * heard over WebRTC from the audio server — the audio counterpart of a camera
 * view. It shows whether the mic is on air (polled from GET /v1/streams) and
 * its live level. A mic that is not there yet (404) or off air is waited for
 * and retried instead of being a dead end; a dropped connection is retried
 * with backoff. When the browser refuses to play sound without a tap there is
 * a clear button for it. Closing the card closes the peer connection and
 * DELETEs the server session.
 */
function AudioStreamBox({ box }) {
  const audioRef = useRef(null)
  const fillRef = useRef(null)
  const [listening, setListening] = useState(true)
  // connecting | live | waiting | disconnected | failed | closed | error
  const [conn, setConn] = useState('connecting')
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
        // Not there (yet): the mic is off or still connecting. Wait for it.
        if (err?.status === 404) {
          setConn('waiting')
          return
        }
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

  // ── reconnect after a drop, a transient failure, or while waiting for the mic ──
  useEffect(() => {
    if (!listening) return
    const dropped = conn === 'failed' || conn === 'closed' || conn === 'disconnected'
    const waiting = conn === 'waiting'
    if (!dropped && !waiting && !(conn === 'error' && error?.retryable)) return
    const delay = waiting ? WAIT_RETRY_MS : Math.min(RETRY_BASE_MS * 2 ** retriesRef.current, RETRY_MAX_MS)
    const timer = setTimeout(() => {
      if (!waiting) retriesRef.current += 1
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

  // A waiting card reconnects as soon as the poll sees the mic come on air.
  useEffect(() => {
    if (listening && conn === 'waiting' && onAir) setAttempt(a => a + 1)
  }, [onAir]) // eslint-disable-line react-hooks/exhaustive-deps

  const live = listening && conn === 'live'
  const resumeMeter = useLevelMeter(audioRef, fillRef, live && !blocked)

  let dot = 'connecting'
  let status = 'Connecting…'
  if (!listening) {
    dot = 'idle'
    status = 'Stopped'
  } else if (conn === 'waiting') {
    dot = 'waiting'
    status = 'Waiting for the mic… it will play as soon as it is on air'
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

  const unblock = () => {
    const played = audioRef.current?.play?.()
    played?.then?.(() => setBlocked(false)).catch(() => {})
    resumeMeter()
  }

  return (
    <div className={`abox abox--live${live && onAir !== false ? ' abox--on-air' : ''}`}>
      <audio ref={audioRef} className="abox__player" controls autoPlay playsInline />
      <div className="abox__level" aria-hidden="true">
        <span className="abox__level-fill" ref={fillRef} />
      </div>
      <div className="abox__meta">
        <Status dot={dot} error={conn === 'error' && listening}>{status}</Status>
        <button className="devices__btn" onClick={toggle} title={listening ? 'Stop listening' : 'Listen again'}>
          {listening ? 'Stop' : 'Listen'}
        </button>
      </div>
      {blocked && listening && (
        <button className="abox__unblock" onClick={unblock}>▶ Tap to listen</button>
      )}
    </div>
  )
}

/**
 * AudioBox — the content of an audio card on the stage (the card carries the
 * title and Close; closing unmounts this, which stops playback and hangs up).
 *
 * box.type === 'audio'         { url, mime, label, autoplay, durationS, voice }  (play_audio)
 * box.type === 'audio_stream'  { streamId, label }                               (show_audio_stream)
 */
export default function AudioBox({ box }) {
  return box.type === 'audio_stream'
    ? <AudioStreamBox box={box} />
    : <AudioClipBox box={box} />
}
