import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Toggle } from './SettingsPanel.jsx'
import { listStreams, micStreamId } from '../lib/audioStreams.js'

const POLL_MS = 5000

function describe(s) {
  const parts = [s.live ? 'live' : 'offline']
  if (s.listeners > 0) parts.push(`${s.listeners} listening`)
  if (s.buffered_s > 0) parts.push(`${Math.round(s.buffered_s)} s buffered`)
  if (s.source) parts.push(s.source === 'ws' ? 'device' : 'browser')
  return parts.join(' · ')
}

/**
 * Live audio streams — every microphone publishing to the audio server that
 * this account can hear (ESP32 mics, other browsers, phones), and a switch to
 * publish this device's own.
 *
 * Listening opens a live audio card on the stage, the same card the brain
 * opens with show_audio_stream, so it keeps playing after this panel closes.
 * Sharing is owned by ChatView for the same reason.
 *
 * Props:
 *   onClose()
 *   onListen(stream)              open a live audio card for {id, name}
 *   micShare { on, busy, error }  this device's mic broadcast
 *   onToggleMicShare(next)
 */
export default function AudioStreamsPanel({ onClose, onListen, micShare, onToggleMicShare }) {
  const [streams, setStreams] = useState(null)      // null until the first answer
  const [error, setError] = useState('')
  const myStream = micStreamId()

  const refresh = useCallback(async (signal) => {
    try {
      const list = await listStreams({ signal })
      setStreams(list)
      setError('')
    } catch (err) {
      if (err?.name === 'AbortError') return
      setError(err?.userMessage || err?.message || 'Could not load the streams.')
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    refresh(ctrl.signal)
    const id = setInterval(() => refresh(ctrl.signal), POLL_MS)
    return () => {
      clearInterval(id)
      ctrl.abort()
    }
  }, [refresh])

  // A changed share shows up in the list straight away, not at the next poll.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    if (!micShare?.busy) refresh()
  }, [micShare?.on, micShare?.busy, refresh])

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <div className="settings-panel streams-panel" role="dialog" aria-label="Live audio streams">
        <div className="settings-panel__header">
          <span className="settings-panel__title">Live audio</span>
          <button className="settings-panel__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="settings-panel__body">
          <div>
            <div className="settings-section__label">This device</div>
            <div className="settings-row">
              <span className="settings-row__label">
                Share this device's microphone
                <span className="settings-row__hint">
                  {micShare?.busy
                    ? 'Connecting…'
                    : micShare?.on
                      ? `Broadcasting as ${myStream}. Nandi and your other devices can listen.`
                      : 'Lets Nandi and your other devices hear this room.'}
                </span>
              </span>
              <Toggle
                value={!!micShare?.on}
                onChange={(next) => { if (!micShare?.busy) onToggleMicShare(next) }}
                label="Share this device's microphone"
              />
            </div>
            {micShare?.error && <div className="streams-panel__error" role="alert">{micShare.error}</div>}
          </div>

          <div>
            <div className="settings-section__label">Streams</div>
            {error && <div className="streams-panel__error" role="alert">{error}</div>}
            {streams === null && !error && <div className="streams-panel__empty">Loading…</div>}
            {streams?.length === 0 && (
              <div className="streams-panel__empty">
                No microphones are streaming right now.
              </div>
            )}
            {streams?.map(s => {
              const mine = s.id === myStream
              return (
                <div key={s.id} className="settings-row streams-panel__row">
                  <span className="streams-panel__info">
                    <span className="streams-panel__name">
                      <span className={`abox__dot abox__dot--${s.live ? 'live' : 'offline'}`} />
                      {s.name || s.id}
                      {mine && <span className="streams-panel__mine">this device</span>}
                    </span>
                    <span className="streams-panel__meta">{describe(s)}</span>
                  </span>
                  <button
                    className="settings-url__btn"
                    onClick={() => onListen(s)}
                    disabled={mine}
                    title={mine ? 'Listening to your own microphone here would feed back' : `Listen to ${s.name || s.id}`}
                  >
                    Listen
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
