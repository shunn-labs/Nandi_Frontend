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
  WAKE_SENSITIVITIES,
  FOLLOWUP_CHOICES,
  getVoiceDuplex,
  getVoiceLang,
  setVoiceDuplex,
  setVoiceLang,
  getWakeEnabled,
  setWakeEnabled,
  getWakeSensitivity,
  setWakeSensitivity,
  getFollowupSeconds,
  setFollowupSeconds,
  getBeepsEnabled,
  setBeepsEnabled,
} from '../lib/voicePrefs.js'
import { watchPermission, requestMediaAccess } from '../lib/mediaPermission.js'
import { playBeep } from '../lib/beeps.js'
import { THEMES, SCHEMES } from '../lib/themes.js'
import { isSoundEnabled, setSoundEnabled, playChime } from '../lib/chime.js'
import { AMBIENT_CHOICES } from '../lib/uiPrefs.js'
import { isDesktop } from '../lib/desktop.js'
import DesktopSettings from './desktop/DesktopSettings.jsx'

const PERM_LABEL = { granted: 'allowed ✓', prompt: 'not yet', denied: 'blocked', unknown: '—', unavailable: 'unavailable' }

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
 * `theme` (accent) and `scheme` (light / dark) are owned by ChatView too: the menu, the command palette and the T key
 * change it as well. So is `ambientDelay`: ChatView's idle timer reads it.
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
  theme,
  onThemeChange,
  scheme,
  onSchemeChange,
  onOpenAudioStreams,
  ambientDelay,
  onAmbientDelayChange,
}) {
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('nandi_auto_send_stt') !== 'false'
  })
  const [voiceLang, setVoiceLangValue] = useState(getVoiceLang)
  const [bargeIn, setBargeIn] = useState(() => getVoiceDuplex() === 'full')
  const [audioBase, setAudioBase] = useState(AUDIO_BASE)
  const [audioDraft, setAudioDraft] = useState(getAudioBaseOverride)
  const [audioError, setAudioError] = useState('')
  const [wakeOn, setWakeOn] = useState(getWakeEnabled)
  const [wakeSens, setWakeSens] = useState(getWakeSensitivity)
  const [followup, setFollowup] = useState(getFollowupSeconds)
  const [beeps, setBeeps] = useState(getBeepsEnabled)
  const [micPerm, setMicPerm] = useState('unknown')
  const [camPerm, setCamPerm] = useState('unknown')
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    const offMic = watchPermission('microphone', setMicPerm)
    const offCam = watchPermission('camera', setCamPerm)
    return () => { offMic(); offCam() }
  }, [])

  const askMedia = async () => {
    setAsking(true)
    try {
      const r = await requestMediaAccess({ audio: micPerm !== 'granted', video: camPerm !== 'granted' })
      if (r.microphone) setMicPerm(r.microphone)
      if (r.camera) setCamPerm(r.camera)
    } finally {
      setAsking(false)
    }
  }

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

  const [chime, setChime] = useState(isSoundEnabled)
  const onChimeChange = (next) => {
    setSoundEnabled(next)
    setChime(next)
    if (next) playChime('info')          // the click unlocks audio, so this is heard
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

          {/* The Nandi desktop app (only inside it) */}
          {isDesktop && <DesktopSettings />}

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
              <span className="settings-row__label">Notification sound</span>
              <Toggle value={chime} onChange={onChimeChange} />
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
                Wake word “Hey Nandi”
                <span className="settings-row__hint">
                  In voice mode (Ctrl+H) Nandi sleeps until you say “Hey Nandi” or “Hi Nandi”,
                  like the Raspberry Pi. Off: she always listens while voice mode is on.
                </span>
              </span>
              <Toggle value={wakeOn} onChange={(v) => { setWakeEnabled(v); setWakeOn(v) }} label="Wake word" />
            </div>
            {wakeOn && (
              <>
                <div className="settings-row">
                  <label className="settings-row__label" htmlFor="settings-wake-sens">
                    Wake sensitivity
                    <span className="settings-row__hint">Raise it if she misses you; lower it if she wakes by herself.</span>
                  </label>
                  <select id="settings-wake-sens" className="settings-select" value={wakeSens}
                    onChange={(e) => { setWakeSensitivity(e.target.value); setWakeSens(getWakeSensitivity()) }}>
                    {WAKE_SENSITIVITIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="settings-row">
                  <label className="settings-row__label" htmlFor="settings-followup">
                    Follow-up time
                    <span className="settings-row__hint">After she answers, keep talking without “Hey Nandi”.</span>
                  </label>
                  <select id="settings-followup" className="settings-select" value={followup}
                    onChange={(e) => { setFollowupSeconds(e.target.value); setFollowup(getFollowupSeconds()) }}>
                    {FOLLOWUP_CHOICES.map(n => <option key={n} value={n}>{n ? `${n} s` : 'None'}</option>)}
                  </select>
                </div>
                <div className="settings-row">
                  <span className="settings-row__label">Wake / sleep beeps</span>
                  <Toggle value={beeps} onChange={(v) => { setBeepsEnabled(v); setBeeps(v); if (v) playBeep('wake') }}
                    label="Wake and sleep beeps" />
                </div>
              </>
            )}
            {!wakeOn && (
              <div className="settings-row">
                <span className="settings-row__label">
                  Barge-in
                  <span className="settings-row__hint">
                    Talk over Nandi to interrupt her. Turn off if your speaker is
                    loud enough for her to interrupt herself. (With the wake word on,
                    only “Hey Nandi” interrupts her.)
                  </span>
                </span>
                <Toggle value={bargeIn} onChange={changeBargeIn} label="Barge-in" />
              </div>
            )}
            <div className="settings-row settings-row--stack">
              <span className="settings-row__label">
                Microphone &amp; camera access
                <span className="settings-row__hint">
                  Your browser remembers this for this site until you clear its data — when it asks,
                  choose “Allow while visiting the site” (Chrome/Edge) or tick “Remember this decision” (Firefox).
                </span>
              </span>
              <div className="settings-perms">
                <span className={`settings-perm settings-perm--${micPerm}`}>Microphone: {PERM_LABEL[micPerm] || micPerm}</span>
                <span className={`settings-perm settings-perm--${camPerm}`}>Camera: {PERM_LABEL[camPerm] || camPerm}</span>
                {(micPerm !== 'granted' || camPerm !== 'granted') && (
                  <button className="settings-url__btn" onClick={askMedia} disabled={asking}>
                    {asking ? 'Asking…' : 'Allow now'}
                  </button>
                )}
              </div>
              {(micPerm === 'denied' || camPerm === 'denied') && (
                <span className="settings-url__error" role="alert">
                  Blocked earlier: click the icon left of the address bar ▸ Site settings, and set it to Allow.
                </span>
              )}
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

          {/* Appearance */}
          <div>
            <div className="settings-section__label">Appearance</div>
            <div className="scheme-picker" role="radiogroup" aria-label="Appearance">
              {Object.entries(SCHEMES).map(([key, label]) => (
                <button key={key} role="radio" aria-checked={scheme === key}
                  className={`scheme-picker__option${scheme === key ? ' scheme-picker__option--on' : ''}`}
                  onClick={() => onSchemeChange(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Accent */}
          <div>
            <div className="settings-section__label">Accent</div>
            <div className="theme-picker" role="radiogroup" aria-label="Theme">
              {Object.entries(THEMES).map(([key, t]) => (
                <button
                  key={key}
                  role="radio"
                  aria-checked={theme === key}
                  className={`theme-picker__option${theme === key ? ' theme-picker__option--on' : ''}`}
                  onClick={() => onThemeChange(key)}
                >
                  <i style={{ background: t.swatch }} />
                  {t.name}
                </button>
              ))}
            </div>
            <p className="theme-picker__note">{THEMES[theme]?.note} Press T to cycle.</p>
          </div>

          {/* Interface */}
          <div>
            <div className="settings-section__label">Interface</div>
            <div className="settings-row">
              <span className="settings-row__label">Show activity logs</span>
              <Toggle value={showLogs} onChange={onShowLogsChange} />
            </div>
            {onAmbientDelayChange && (
              <div className="settings-row">
                <label className="settings-row__label" htmlFor="settings-ambient">
                  Ambient mode after
                  <span className="settings-row__hint">
                    When nothing is happening and nothing is on screen, only the core and a clock stay. Any key or touch brings everything back.
                  </span>
                </label>
                <select
                  id="settings-ambient"
                  className="settings-select"
                  value={ambientDelay}
                  onChange={(e) => onAmbientDelayChange(Number(e.target.value))}
                >
                  {AMBIENT_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            )}
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
