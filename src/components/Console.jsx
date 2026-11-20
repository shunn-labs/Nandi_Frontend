import React, { useRef, useState } from 'react'
import LogPanel from './LogPanel.jsx'
import Transcript from './Transcript.jsx'
import ActivityCard from './ActivityCard.jsx'
import useCameras from '../hooks/useCameras.js'

const TABS = [
  { key: 'transcript', label: 'Transcript' },
  { key: 'logs', label: 'Logs' },
  { key: 'activity', label: 'Activity' },
  { key: 'devices', label: 'Devices' },
]
const DOMAIN_LABEL = { android: 'Phone', ubuntu_control: 'PC' }

/**
 * The console at the bottom, like VS Code's terminal. Folded, it is one line
 * showing the latest log; open, it has tabs for the transcript, the brain's
 * logs, running jobs and connected devices. Drag its top edge to resize.
 *
 * Every pane stays mounted while folded, so the log socket keeps collecting.
 */
export default function Console({
  open, onToggle, tab, onTab,
  messages, activities, onStopActivity,
  showLogs, connected,
  capDevices, vision,
}) {
  const [latestLog, setLatestLog] = useState('')
  const cams = useCameras(open && tab === 'devices')
  const [height, setHeight] = useState(220)
  const drag = useRef(null)

  const onGripDown = (e) => {
    drag.current = { y: e.clientY, h: height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onGripMove = (e) => {
    if (!drag.current) return
    setHeight(Math.max(90, Math.min(window.innerHeight * 0.6, drag.current.h + drag.current.y - e.clientY)))
  }
  const onGripUp = () => { drag.current = null }

  const deviceRows = Object.entries(capDevices).flatMap(([domain, list]) =>
    list.map(d => ({ key: `${domain}-${d.id}`, name: d.name || d.id, kind: DOMAIN_LABEL[domain] || domain,
      detail: [d.model, d.busy ? 'busy' : ''].filter(Boolean).join(' · ') })))

  return (
    <section className={`console${open ? '' : ' console--folded'}`} aria-label="Console">
      {open && <div className="console__grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} />}
      <div className="console__bar">
        <button className="console__toggle" onClick={onToggle} aria-expanded={open} title="Console (Ctrl+`)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
          Console
        </button>
        {open ? (
          <div className="console__tabs" role="tablist">
            {TABS.map(t => (
              <button key={t.key} role="tab" aria-selected={tab === t.key}
                className={`console__tab${tab === t.key ? ' console__tab--on' : ''}`} onClick={() => onTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <button className="console__latest" onClick={() => { onTab('logs'); onToggle() }}>{latestLog}</button>
        )}
        <span className={`console__status${connected ? '' : ' console__status--off'}`}>
          <i />{connected ? 'connected' : 'offline'}
        </span>
      </div>

      <div className="console__body" style={{ height }}>
        <div hidden={tab !== 'transcript'}><Transcript messages={messages} /></div>
        <div hidden={tab !== 'logs'}>
          {showLogs ? <LogPanel onLatest={setLatestLog} />
            : <div className="console__pane console__empty">Logs are switched off in Settings.</div>}
        </div>
        <div hidden={tab !== 'activity'} className="console__pane console__cards">
          {activities.length === 0 && <div className="console__empty">No jobs yet.</div>}
          {[...activities].reverse().map(a => <ActivityCard key={a.id} item={a} onStop={onStopActivity} />)}
        </div>
        <div hidden={tab !== 'devices'} className="console__pane">
          <table className="devices">
            <tbody>
              <tr>
                <td>Vision link</td>
                <td className={vision.ctrlConnected ? 'devices__on' : 'devices__off'}>{vision.ctrlConnected ? 'connected' : 'not connected'}</td>
                <td>{vision.ctrlError ? `Refused: ${vision.ctrlError}` : 'camera frames and streams from Nandi'}</td>
              </tr>
              <tr>
                <td>This device's camera</td>
                <td className={vision.cameraOn ? 'devices__on' : 'devices__off'}>{vision.cameraOn ? 'sharing' : 'off'}</td>
                <td><button className="devices__btn" onClick={vision.toggleCamera}>{vision.cameraOn ? 'Stop sharing' : 'Share camera'}</button></td>
              </tr>
              {deviceRows.map(d => (
                <tr key={d.key}><td>{d.name}</td><td className="devices__on">{d.kind} online</td><td>{d.detail}</td></tr>
              ))}
            </tbody>
          </table>

          <div className="cams__head">
            Cameras
            <button className="logs__clear" onClick={cams.refresh}>Refresh</button>
          </div>
          {cams.error && <div className="cams__error">{cams.error}</div>}
          {!cams.error && cams.cameras.length === 0 && <div className="console__empty">No cameras known yet.</div>}
          {cams.cameras.length > 0 && (
            <table className="devices cams">
              <tbody>
                {cams.cameras.map(c => {
                  const showing = vision.boxes.some(b => b.streamId === c.id)
                  return (
                    <tr key={c.id}>
                      <td>{c.name || c.id}</td>
                      <td><code className="cams__id" title="Stream ID">{c.id}</code></td>
                      <td className={c.live ? 'devices__on' : 'devices__off'}>
                        {c.live ? 'live' : c.last_seen_s_ago != null ? `seen ${ago(c.last_seen_s_ago)} ago` : 'offline'}
                      </td>
                      <td>
                        <button className="devices__btn" onClick={() => vision.openStream(c.id, c.name)}
                          title={c.live ? 'Show this camera' : 'Opens and waits until the camera starts sending'}>
                          {showing ? 'Show' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <StreamOpener onOpen={vision.openStream} />
        </div>
      </div>
    </section>
  )
}

function ago(s) {
  if (s < 90) return `${Math.round(s)} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

/** Opens a stream that is not in the list, by its id (e.g. pc_cam). */
function StreamOpener({ onOpen }) {
  const [id, setId] = useState('')
  const submit = (e) => {
    e.preventDefault()
    if (!id.trim()) return
    onOpen(id.trim())
    setId('')
  }
  return (
    <form className="devices__stream" onSubmit={submit}>
      <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Other stream ID, e.g. pc_cam" aria-label="Stream ID" />
      <button className="devices__btn" type="submit" disabled={!id.trim()}>Open stream</button>
    </form>
  )
}
