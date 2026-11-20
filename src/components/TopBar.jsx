import React, { useEffect, useRef, useState } from 'react'
import { CORE_STATES } from './Core.jsx'

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

/**
 * The quiet line at the top: name, a status dot, the clock and one menu.
 *
 * menuItems  [{ label, hint, onSelect }]; a `null` entry draws a divider
 */
export default function TopBar({ coreState, menuItems }) {
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
        <span className="topbar__clock">{time}</span>
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
