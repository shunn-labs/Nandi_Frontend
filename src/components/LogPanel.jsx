import React, { useEffect, useRef, useState } from 'react'
import { LOGS_WS } from '../lib/endpoints.js'

// This panel used to carry its own hardcoded server list, headed by production,
// and pick between them with a health probe. That bypassed endpoints.js
// entirely, so a dev build streamed the LIVE server's logs — the same
// dev-reaches-production problem the chat socket had, and a leak of one
// environment's activity into another. The target now comes from the build mode
// like every other connection.

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000

function backoffDelay(attempt) {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS)
  return base * (0.75 + Math.random() * 0.5)   // jitter, so tabs don't sync up
}

function getToken() {
  return localStorage.getItem('user_token')
}

function classifyLog(msg) {
  if (!msg) return 'info'
  const lower = msg.toLowerCase()
  if (lower.includes('error') || lower.includes('failed') || lower.includes('❌')) return 'error'
  if (lower.includes('warn') || lower.includes('⚠️')) return 'warn'
  if (lower.includes('route') || lower.includes('→') || lower.includes('selected')) return 'step'
  return 'info'
}

/**
 * The brain's live log, shown in the console's Logs tab.
 *
 * onLatest(msg)  called with each new line, for the folded console's status line
 */
export default function LogPanel({ onLatest }) {
  const [logs, setLogs] = useState([])
  const [connected, setConnected] = useState(false)
  const bodyRef = useRef(null)
  const followRef = useRef(true)
  // Read through a ref: the socket handler below is set up once.
  const onLatestRef = useRef(onLatest)
  useEffect(() => { onLatestRef.current = onLatest }, [onLatest])
  const wsRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let attempt = 0
    let retryTimer = null

    function connect() {
      if (cancelled) return

      // Checked BEFORE opening the socket, not in onopen. Closing from inside
      // onopen produces a close event with code 1005, which is not the 1008
      // the reconnect guard below looks for — so every signed-out tab opened a
      // socket, closed it, and scheduled another, forever. Now there is simply
      // no socket until there is a token.
      if (!getToken()) {
        console.warn('[logs] no token — not connecting')
        setConnected(false)
        return
      }

      if (wsRef.current) {
        // Detach handlers before closing. Otherwise the outgoing socket's
        // onclose fires and schedules a reconnect that races the one we are
        // opening right now — the same storm the chat socket suffered.
        const old = wsRef.current
        old.onopen = old.onmessage = old.onerror = old.onclose = null
        try { old.close() } catch {}
      }

      const ws = new WebSocket(LOGS_WS)
      wsRef.current = ws

      const isStale = () => cancelled || wsRef.current !== ws

      ws.onopen = () => {
        if (isStale()) return
        const token = getToken()
        if (!token) {
          // Signed out between connect() and onopen.
          try { ws.close() } catch {}
          return
        }
        ws.send(JSON.stringify({ type: 'auth', token }))
      }

      ws.onmessage = (event) => {
        if (isStale()) return
        let data
        try { data = JSON.parse(event.data) } catch { return }

        if (data.status === 'authenticated') {
          attempt = 0            // reset backoff only on a confirmed success
          setConnected(true)
          return
        }

        if (data.error) return

        const msg = data.log || data.message || JSON.stringify(data)
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
        onLatestRef.current?.(msg)

        setLogs(prev => [...prev.slice(-200), {   // keep last 200
          id: Date.now() + Math.random(),
          msg,
          ts,
          type: classifyLog(msg),
        }])
      }

      ws.onerror = () => {
        if (isStale()) return
        setConnected(false)
      }

      ws.onclose = (event) => {
        if (isStale()) return
        setConnected(false)

        // 1008 is the server rejecting our auth frame. Reconnecting with the
        // same token just repeats the rejection forever; the chat socket's
        // auth-failure path is what sends the user back to login.
        if (event && event.code === 1008) return

        if (retryTimer) return
        retryTimer = setTimeout(() => {
          retryTimer = null
          connect()
        }, backoffDelay(attempt++))
      }
    }

    connect()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      const sock = wsRef.current
      if (sock) {
        sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null
        try { sock.close() } catch {}
      }
      wsRef.current = null
    }
  }, [])

  // Follow new lines unless the user has scrolled up to read.
  useEffect(() => {
    const el = bodyRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [logs])

  const onScroll = () => {
    const el = bodyRef.current
    followRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80
  }

  return (
    <div className="console__pane" ref={bodyRef} onScroll={onScroll}>
      <div className="logs__head">
        <span className={`logs__dot${connected ? '' : ' logs__dot--off'}`} />
        {connected ? 'Streaming brain logs' : 'Log stream not connected'}
        <button className="logs__clear" onClick={() => setLogs([])}>Clear</button>
      </div>
      {logs.length === 0 ? (
        <div className="console__empty">Waiting for activity…</div>
      ) : (
        logs.map(log => (
          <div key={log.id} className={`log-entry log-entry--${log.type}`}>
            <span className="log-entry__ts">{log.ts}</span>
            <span className="log-entry__msg">{log.msg}</span>
          </div>
        ))
      )}
    </div>
  )
}
