import React, { useEffect, useRef, useState } from 'react'
import { CORE_STATES } from './Core.jsx'
import { SCHEMES } from '../lib/themes.js'

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(id)
  }, [])
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Ambient mode: only the core and a big clock stay on screen. */
export function AmbientClock() {
  const time = useClock()
  const date = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  return <div className="ambient-clock">{time}<small>{date}</small></div>
}

const SCHEME_ICON = {
  system: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></>,
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" /></>,
  dark: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
}

/**
 * The quiet line at the top: name, a status dot, the clock, the appearance
 * switch (match system / light / dark) and one menu.
 *
 * menuItems  [{ label, hint, onSelect }]; a `null` entry draws a divider
 * notice     optional { label, title, onClick }: a pill that stays visible
 *            while something needs to be (this device's mic is being shared)
 * assistant  optional (the desktop app): { listening, auto, onToggle } — the
 *            "Hey Nandi" switch next to the menu
 */
export default function TopBar({ coreState, menuItems, scheme, onScheme, notice, assistant }) {
  const time = useClock()
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (e) => { if (!menuRef.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const label = (CORE_STATES[coreState] || CORE_STATES.idle).label

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark">NANDI</span>
        <span className={`topbar__dot topbar__dot--${coreState}`} title={label} aria-label={label} role="status" />
      </div>
      <div className="topbar__right" ref={menuRef}>
        {notice && (
          <button className="topbar__notice" onClick={notice.onClick} title={notice.title}>
            <i aria-hidden="true" />{notice.label}
          </button>
        )}
        <span className="topbar__clock">{time}</span>
        <div className="seg" role="group" aria-label="Appearance">
          {Object.entries(SCHEMES).map(([key, label]) => (
            <button key={key} className="seg__btn" aria-pressed={scheme === key} title={label} aria-label={label}
              onClick={() => onScheme(key)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{SCHEME_ICON[key]}</svg>
            </button>
          ))}
        </div>
        {assistant && (
          <button
            className={`icon-btn assistant-toggle${assistant.listening ? ' assistant-toggle--on' : ''}${assistant.auto ? ' assistant-toggle--auto' : ''}`}
            onClick={assistant.onToggle}
            aria-pressed={assistant.listening}
            aria-label={assistant.listening ? 'Pause listening for “Hey Nandi”' : 'Listen for “Hey Nandi”'}
            title={assistant.auto ? 'Sleeping while another app uses the mic' : assistant.listening ? 'Listening for “Hey Nandi” (Ctrl+H pauses)' : 'Paused (Ctrl+H to listen)'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              {!assistant.listening && <path d="M4 4l16 16" />}
            </svg>
            {assistant.listening && !assistant.auto && <span className="assistant-toggle__dot" aria-hidden="true" />}
          </button>
        )}
        <button className="icon-btn" onClick={() => setOpen(o => !o)}
          aria-label="Menu" aria-expanded={open} aria-haspopup="menu">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {open && (
          <div className="menu" role="menu">
            {menuItems.map((item, i) => item === null ? (
              <hr key={`d${i}`} className="menu__divider" />
            ) : (
              <button key={item.label} className="menu__item" role="menuitem"
                onClick={() => { setOpen(false); item.onSelect() }}>
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}
