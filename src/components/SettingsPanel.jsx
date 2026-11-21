import React, { useState, useEffect } from 'react'
import {
  API_BASE,
  AUDIO_BASE,
  DEFAULT_AUDIO_BASE,
  getAudioBaseOverride,
  setAudioBaseOverride,
} from '../lib/endpoints.js'
import {
  VOICE_LANGUAGES,
  getVoiceDuplex,
  getVoiceLang,
  setVoiceDuplex,
  setVoiceLang,
} from '../lib/voicePrefs.js'

function getDeviceId() {
  const match = document.cookie.match(/(?:^|;\s*)nandi_device_id=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : 'Unknown'
}

// Declared at module scope, not inside SettingsPanel. A component defined in
// the render body gets a fresh identity on every render, so React tore down and
// rebuilt EVERY toggle's DOM whenever any one setting changed — restarting the
// knob's CSS transition mid-slide and throwing away focus. Exported for the
// other panels (AudioStreamsPanel) so every switch looks and behaves the same.
export function Toggle({ value, onChange, label }) {
  return (
    <div
      className={`settings-toggle${value ? ' settings-toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
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
 * there is no second copy to fall out of step. The voice settings (language,
 * barge-in, audio server) work the same way: they are read when a request or
 * a voice session starts, so a change applies to the next one.
 */
export default function SettingsPanel({
  onClose,
  onLogout,
  ttsEnabled,
  onTtsChange,
  showLogs,
  onShowLogsChange,
  onOpenAudioStreams,
}) {
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('nandi_auto_send_stt') !== 'false'
  })
  const [voiceLang, setVoiceLangValue] = useState(getVoiceLang)
  const [bargeIn, setBargeIn] = useState(() => getVoiceDuplex() === 'full')
  const [audioBase, setAudioBase] = useState(AUDIO_BASE)
  const [audioDraft, setAudioDraft] = useState(getAudioBaseOverride)
  const [audioError, setAudioError] = useState('')

  useEffect(() => {
    localStorage.setItem('nandi_auto_send_stt', autoSend)
  }, [autoSend])

  const changeVoiceLang = (e) => {
    setVoiceLang(e.target.value)
    setVoiceLangValue(getVoiceLang())
  }

  const changeBargeIn = (next) => {
    setVoiceDuplex(next ? 'full' : 'half')
    setBargeIn(next)
  }

  const applyAudioBase = (value) => {
    try {
      setAudioBase(setAudioBaseOverride(value))
      setAudioDraft(getAudioBaseOverride())
      setAudioError('')
    } catch (err) {
      setAudioError(err.message)
    }
  }

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
            <div className="settings-row">
              <label className="settings-row__label" htmlFor="settings-voice-lang">Voice language</label>
              <select
                id="settings-voice-lang"
                className="settings-select"
                value={voiceLang}
                onChange={changeVoiceLang}
              >
                {VOICE_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">
                Barge-in
                <span className="settings-row__hint">
                  Talk over Nandi to interrupt her. Turn off if your speaker is
                  loud enough for her to interrupt herself.
                </span>
              </span>
              <Toggle value={bargeIn} onChange={changeBargeIn} label="Barge-in" />
            </div>
            <form
              className="settings-row settings-row--stack"
              onSubmit={(e) => { e.preventDefault(); applyAudioBase(audioDraft) }}
            >
              <label className="settings-row__label" htmlFor="settings-audio-base">
                Audio server
                <span className="settings-row__hint">
                  Speech, voice mode and live audio. Applies to the next request or voice session.
                </span>
              </label>
              <div className="settings-url">
                <input
                  id="settings-audio-base"
                  className="settings-url__input"
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  placeholder={DEFAULT_AUDIO_BASE}
                  value={audioDraft}
                  onChange={(e) => setAudioDraft(e.target.value)}
                />
                <button type="submit" className="settings-url__btn">Save</button>
                {getAudioBaseOverride() && (
                  <button type="button" className="settings-url__btn" onClick={() => applyAudioBase('')}>
                    Reset
                  </button>
                )}
              </div>
              {audioError && <span className="settings-url__error" role="alert">{audioError}</span>}
            </form>
            {onOpenAudioStreams && (
              <div className="settings-row">
                <span className="settings-row__label">Live audio streams</span>
                <button className="settings-url__btn" onClick={onOpenAudioStreams}>Open</button>
              </div>
            )}
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
            <div className="settings-row">
              <span className="settings-row__label">Audio</span>
              <span className="settings-row__value">{new URL(audioBase).host}</span>
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
