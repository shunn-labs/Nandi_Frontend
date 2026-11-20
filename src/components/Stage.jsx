import React, { useEffect, useState } from 'react'

// Below this width there is no room beside the focused panel, so older panels
// wait in the tray instead of at the sides.
const SIDES_QUERY = '(min-width: 1180px)'

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * The stage: whatever Nandi puts on screen, one thing in front at a time.
 *
 * The focused panel sits in the middle. The newest other panel waits on the
 * right, the next on the left (wide screens only), and everything else goes to
 * the tray, from where it can be brought back.
 *
 * panels      [{ id, title, source, alert, content }] oldest first
 * focusId     the panel in the middle, or null
 * minimized   Set of ids the user put away
 */
export default function Stage({ panels, focusId, minimized, onFocus, onClose, onMinimize }) {
  const sides = useMediaQuery(SIDES_QUERY)
  const visible = panels.filter(p => !minimized.has(p.id))
  const others = visible.filter(p => p.id !== focusId).reverse()   // newest first
  const slots = sides ? ['right', 'left'] : []

  const roleOf = (p) => {
    if (p.id === focusId && !minimized.has(p.id)) return 'focus'
    const i = others.indexOf(p)
    return i >= 0 && i < slots.length ? slots[i] : 'tray'
  }
  const tray = panels.filter(p => roleOf(p) === 'tray')

  return (
    <>
      <div className="stage">
        {panels.map(p => {
          const role = roleOf(p)
          return (
            <section
              key={p.id}
              className={`panel panel--${role}${p.alert ? ' panel--alert' : ''}`}
              aria-label={p.title}
              aria-hidden={role === 'tray'}
              onClick={(e) => {
                if (role !== 'focus' && !e.target.closest('button, input, select, textarea, a')) onFocus(p.id)
              }}
            >
              <header className="panel__head">
                <h2 className="panel__title">{p.title}</h2>
                {p.source && <span className="panel__source">{p.source}</span>}
                <div className="panel__btns">
                  <button className="panel__btn" onClick={() => onMinimize(p.id)} title="Put away" aria-label={`Put away ${p.title}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 17h12" /></svg>
                  </button>
                  <button className="panel__btn" onClick={() => onClose(p.id)} title="Close (Esc)" aria-label={`Close ${p.title}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
              </header>
              <div className="panel__body">{p.content}</div>
            </section>
          )
        })}
      </div>

      {tray.length > 0 && (
        <div className="tray">
          {tray.map(p => (
            <button key={p.id} className={`tray__chip${p.alert ? ' tray__chip--alert' : ''}`}
              onClick={() => onFocus(p.id)} title={`Bring back: ${p.title}`}>
              {p.title}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
