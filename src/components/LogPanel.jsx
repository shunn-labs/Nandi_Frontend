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

export default function LogPanel() {
  const [logs, setLogs] = useState([])
  const [connected, setConnected] = useState(false)
  const endRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let attempt = 0
    let retryTimer = null

    function connect() {
      if (cancelled) return

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
          // The server closes an unauthenticated log socket with 1008, and we
          // have nothing better to send. Don't spin.
          try { ws.close() } catch {}
          return
        }
        ws.send(JSON.stringify({ type: 'auth', token }))
      }

      ws.onmessage = (event) => {
        if (isStale()) return
        let data
        try { data = JSON.parse(event.data) } catch { return }

        if (data.type === 'authenticated') {
          attempt = 0            // reset backoff only on a confirmed success
          setConnected(true)
          return
        }

        if (data.type === 'error') return

        const msg = data.log || data.message || JSON.stringify(data)
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })

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

  // Auto-scroll (desktop only)
  useEffect(() => {
    if (window.innerWidth > 900) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  return (
    <>
      <div className="log-sidebar__header">
        <span className="log-sidebar__title">
          <span className={`log-sidebar__indicator${connected ? '' : ' log-sidebar__indicator--off'}`} />
          Activity
        </span>
        <button className="log-sidebar__clear" onClick={() => setLogs([])}>Clear</button>
      </div>

      <div className="log-sidebar__body">
        {logs.length === 0 ? (
          <div className="log-sidebar__empty">Waiting for activity…</div>
        ) : (
          logs.map(log => (
            <div key={log.id} className={`log-entry log-entry--${log.type}`}>
              <span className="log-entry__ts">{log.ts}</span>
              <span className="log-entry__msg">{log.msg}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </>
  )
}
