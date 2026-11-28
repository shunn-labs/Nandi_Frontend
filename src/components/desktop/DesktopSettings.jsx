import React, { useCallback, useEffect, useState } from 'react'
import { Toggle } from '../SettingsPanel.jsx'
import { desktop, getDesktopSettings, setDesktopSetting } from '../../lib/desktop.js'

const ECHO_TEXT = {
  on: 'On: music and videos playing on this PC are taken out of what Nandi hears.',
  starting: 'Starting…',
  off: 'Off: Nandi hears the microphone as it is.',
  failed: 'Not working: Nandi uses the microphone as it is.',
}

/**
 * Settings › Desktop: what the Nandi desktop app adds (only shown inside it).
 * Values live in the app (~/.config/Nandi/config.json), not in this page.
 */
export default function DesktopSettings() {
  const [snap, setSnap] = useState(null)
  const [mics, setMics] = useState([])
  const [shortcutDraft, setShortcutDraft] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  const load = useCallback(async () => {
    const s = await getDesktopSettings()
    if (!s) return
    setSnap(s)
    setShortcutDraft(s.settings.shortcut)
    setUrlDraft(s.settings.customUrl)
  }, [])

  useEffect(() => {
    load()
    desktop?.listMics().then(setMics).catch(() => {})
    // The echo canceller takes a moment to come up after a change.
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [load])

  const set = async (key, value) => {
    const r = await setDesktopSetting(key, value)
    if (r?.settings) setSnap({ settings: r.settings, status: r.status })
    if (r?.restart) setNeedsRestart(true)
    return r
  }

  if (!snap) return null
  const { settings: s, status } = snap
  const echo = status.echo || { state: 'off' }

  return (
    <div>
      <div className="settings-section__label">Desktop app</div>

      <div className="settings-row">
        <span className="settings-row__label">
          Listen for “Hey Nandi”
          <span className="settings-row__hint">
            {s.paused ? 'Paused: the microphone is off.' : status.micBusy ? `Sleeping while ${status.micApps?.join(', ') || 'another app'} uses the mic.` : 'Always on, also with the window closed.'}
          </span>
        </span>
        <Toggle value={!s.paused} onChange={(on) => set('paused', !on)} label="Listen for Hey Nandi" />
      </div>

      <div className="settings-row">
        <span className="settings-row__label">
          Start Nandi when I log in
          <span className="settings-row__hint">It starts in the tray, listening.</span>
        </span>
        <Toggle value={s.startAtLogin} onChange={(on) => set('startAtLogin', on)} label="Start at login" />
      </div>

      <div className="settings-row">
        <span className="settings-row__label">
          Echo cancellation
          <span className="settings-row__hint">{ECHO_TEXT[echo.state] || echo.state}{echo.state === 'failed' && echo.error ? ` (${echo.error})` : ''}</span>
        </span>
        <Toggle value={s.echoCancel} onChange={(on) => set('echoCancel', on)} label="Echo cancellation" />
      </div>

      {s.echoCancel && (
        <div className="settings-row">
          <label className="settings-row__label" htmlFor="desk-mic">
            Microphone
            <span className="settings-row__hint">The mic Nandi listens to. Other apps are not affected.</span>
          </label>
          <select id="desk-mic" className="settings-select" value={s.micSource} onChange={(e) => set('micSource', e.target.value)}>
            <option value="">System default</option>
            {mics.map(m => <option key={m.name} value={m.name}>{m.description}</option>)}
          </select>
        </div>
      )}

      <div className="settings-row">
        <label className="settings-row__label" htmlFor="desk-duck">
          When Nandi listens
          <span className="settings-row__hint">What happens to music and videos while you talk to her. They carry on afterwards.</span>
        </label>
        <select id="desk-duck" className="settings-select" value={s.duck} onChange={(e) => set('duck', e.target.value)}>
          <option value="pause">Pause players</option>
          <option value="lower">Lower other sounds</option>
          <option value="off">Leave them</option>
        </select>
      </div>

      <div className="settings-row">
        <span className="settings-row__label">
          Sleep while another app uses the mic
          <span className="settings-row__hint">During calls and recordings Nandi doesn't listen, and comes back after.</span>
        </span>
        <Toggle value={s.pauseWhenMicBusy} onChange={(on) => set('pauseWhenMicBusy', on)} label="Sleep while another app uses the mic" />
      </div>

      <div className="settings-row">
        <label className="settings-row__label" htmlFor="desk-pos">Pop-up position</label>
        <select id="desk-pos" className="settings-select" value={s.popupPosition} onChange={(e) => set('popupPosition', e.target.value)}>
          <option value="bottom">Bottom centre</option>
          <option value="top-right">Top right</option>
        </select>
      </div>

      <div className="settings-row settings-row--stack">
        <label className="settings-row__label" htmlFor="desk-shortcut">
          Talk shortcut
          <span className="settings-row__hint">
            {status.shortcutOk ? 'Works from any app.' : 'Not active: another app has it, or this session is Wayland (then add a system shortcut that runs “nandi --wake”).'}
          </span>
        </label>
        <form className="settings-url" onSubmit={(e) => { e.preventDefault(); set('shortcut', shortcutDraft.trim()) }}>
          <input id="desk-shortcut" className="settings-url__input" value={shortcutDraft} onChange={(e) => setShortcutDraft(e.target.value)}
            placeholder="Control+Alt+N" spellCheck={false} />
          <button className="settings-url__btn" type="submit" disabled={shortcutDraft.trim() === s.shortcut}>Set</button>
        </form>
      </div>

      <div className="settings-row settings-row--stack">
        <label className="settings-row__label" htmlFor="desk-server">
          Nandi server
          <span className="settings-row__hint">{status.origin}</span>
        </label>
        <select id="desk-server" className="settings-select" value={s.server} onChange={(e) => set('server', e.target.value)}>
          <option value="production">Production</option>
          <option value="local">This PC (development)</option>
          <option value="custom">Other address</option>
        </select>
        {s.server === 'custom' && (
          <form className="settings-url" onSubmit={(e) => { e.preventDefault(); set('customUrl', urlDraft.trim()) }}>
            <input className="settings-url__input" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://…" spellCheck={false} />
            <button className="settings-url__btn" type="submit" disabled={urlDraft.trim() === s.customUrl}>Set</button>
          </form>
        )}
      </div>

      {needsRestart && (
        <div className="settings-row">
          <span className="settings-row__label">Restart Nandi to use the new server.</span>
          <button className="settings-url__btn" onClick={() => desktop?.restart()}>Restart</button>
        </div>
      )}

      <div className="settings-row">
        <span className="settings-row__label">Nandi for desktop</span>
        <span className="settings-row__value">v{status.version}</span>
      </div>
    </div>
  )
}
