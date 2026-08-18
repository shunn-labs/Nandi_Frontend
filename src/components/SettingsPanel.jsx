import React, { useState, useEffect } from 'react'
import { API_BASE } from '../lib/endpoints.js'

function getDeviceId() {
  const match = document.cookie.match(/(?:^|;\s*)nandi_device_id=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : 'Unknown'
}

export default function SettingsPanel({ onClose, onLogout }) {
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    return localStorage.getItem('nandi_tts_enabled') !== 'false'
  })
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('nandi_auto_send_stt') !== 'false'
  })
  const [showLogs, setShowLogs] = useState(() => {
    return localStorage.getItem('nandi_show_logs') !== 'false'
  })

  useEffect(() => {
    localStorage.setItem('nandi_tts_enabled', ttsEnabled)
  }, [ttsEnabled])

  useEffect(() => {
    localStorage.setItem('nandi_auto_send_stt', autoSend)
  }, [autoSend])

  useEffect(() => {
    localStorage.setItem('nandi_show_logs', showLogs)
  }, [showLogs])

  const Toggle = ({ value, onChange }) => (
    <div
      className={`settings-toggle${value ? ' settings-toggle--on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <div className="settings-toggle__knob" />
    </div>
  )

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
              <Toggle value={ttsEnabled} onChange={setTtsEnabled} />
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
              <Toggle value={showLogs} onChange={setShowLogs} />
            </div>
          </div>

          {/* Connection */}
          <div>
            <div className="settings-section__label">Connection</div>
            <div className="settings-row">
              <span className="settings-row__label">Backend</span>
              <span className="settings-row__value">{API_BASE.replace(/^https?:\/\//, '')}</span>
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
