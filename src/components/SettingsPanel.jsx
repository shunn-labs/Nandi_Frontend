import React, { useState, useEffect } from 'react'
import { API_BASE } from '../lib/endpoints.js'

function getDeviceId() {
  const match = document.cookie.match(/(?:^|;\s*)nandi_device_id=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : 'Unknown'
}

// Declared at module scope, not inside SettingsPanel. A component defined in
// the render body gets a fresh identity on every render, so React tore down and
// rebuilt EVERY toggle's DOM whenever any one setting changed — restarting the
// knob's CSS transition mid-slide and throwing away focus.
function Toggle({ value, onChange }) {
  return (
    <div
      className={`settings-toggle${value ? ' settings-toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onChange(!value)
        }
      }}
    >
      <div className="settings-toggle__knob" />
    </div>
  )
}

/**
 * Settings.
 *
 * `ttsEnabled` and `showLogs` are owned by ChatView and passed in, they are not
 * local state here. Both used to be read from localStorage once, when this
 * panel mounted, and written back on change — which meant:
 *
 *   - "Auto-speak responses" and the speaker button in the input bar each kept
 *     their own copy. Turning TTS off here left the speaker button lit and
 *     still captioned "TTS enabled", because ChatView had read the value at ITS
 *     mount and never heard about the change.
 *   - "Show activity logs" wrote a key that nothing in the app ever read, so
 *     the toggle moved and nothing happened.
 *
 * One owner per setting removes both.
 *
 * `autoSend` stays local: ChatInput reads the key at the moment it needs it, so
 * there is no second copy to fall out of step.
 */
export default function SettingsPanel({
  onClose,
  onLogout,
  ttsEnabled,
  onTtsChange,
  showLogs,
  onShowLogsChange,
}) {
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('nandi_auto_send_stt') !== 'false'
  })

  useEffect(() => {
    localStorage.setItem('nandi_auto_send_stt', autoSend)
  }, [autoSend])

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <div className="settings-panel">
        <div className="settings-panel__header">
          <span className="settings-panel__title">Settings</span>
          <button className="settings-panel__close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-panel__body">
          {/* Device Info */}
          <div>
            <div className="settings-section__label">Device</div>
            <div className="settings-row">
              <span className="settings-row__label">Device Name</span>
              <span className="settings-row__value">{getDeviceId()}</span>
            </div>
          </div>

          {/* Voice */}
          <div>
            <div className="settings-section__label">Voice</div>
            <div className="settings-row">
              <span className="settings-row__label">Auto-speak responses</span>
              <Toggle value={ttsEnabled} onChange={onTtsChange} />
            </div>
            <div className="settings-row">
              <span className="settings-row__label">Auto-send after speech</span>
              <Toggle value={autoSend} onChange={setAutoSend} />
            </div>
          </div>

          {/* Interface */}
          <div>
            <div className="settings-section__label">Interface</div>
            <div className="settings-row">
              <span className="settings-row__label">Show activity logs</span>
              <Toggle value={showLogs} onChange={onShowLogsChange} />
            </div>
          </div>

          {/* Connection */}
          <div>
            <div className="settings-section__label">Connection</div>
            <div className="settings-row">
              <span className="settings-row__label">Backend</span>
              <span className="settings-row__value">{new URL(API_BASE).host}</span>
            </div>
          </div>
        </div>

        <div className="settings-panel__footer">
          <button className="settings-panel__logout" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      </div>
    </>
  )
}
