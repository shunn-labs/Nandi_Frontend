import React, { useEffect, useRef, useState } from 'react'

// Below this width there is no room beside the focused panel, so older panels
// wait in the tray instead of at the sides.
const SIDES_QUERY = '(min-width: 1180px)'
const MIN_PANEL_W = 280

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

const Icon = ({ d }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
const ICON_MIN = 'M6 17h12'
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18'
const ICON_MAX = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
const ICON_RESTORE = 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'

/**
 * The stage: whatever Nandi puts on screen, one thing in front at a time.
 *
 * The focused panel sits in the middle. The newest other panel waits on the
 * right, the next on the left (wide screens only), and everything else goes to
 * the tray, from where it can be brought back.
 *
 * The panel in front can be resized from its corner, or maximised (button or
 * double-click on its title). A media panel keeps its picture's shape.
 *
 * panels      [{ id, title, source, alert, aspect, content }] oldest first;
 *             `aspect` (width / height) marks a media panel
 * focusId     the panel in the middle, or null
 * minimized   Set of ids the user put away
 */
export default function Stage({ panels, focusId, minimized, onFocus, onClose, onMinimize }) {
  const sides = useMediaQuery(SIDES_QUERY)
  // Widths the user dragged to, and the one maximised panel. Layout only, so
  // they live here rather than with the conversation.
  const [widths, setWidths] = useState({})
  const [maxId, setMaxId] = useState(null)
  const drag = useRef(null)

  const visible = panels.filter(p => !minimized.has(p.id))
  const others = visible.filter(p => p.id !== focusId).reverse()   // newest first
  const slots = sides ? ['right', 'left'] : []

  const roleOf = (p) => {
    if (p.id === focusId && !minimized.has(p.id)) return 'focus'
    const i = others.indexOf(p)
    return i >= 0 && i < slots.length ? slots[i] : 'tray'
  }
  const tray = panels.filter(p => roleOf(p) === 'tray')

  // The panel is centred, so dragging its corner by dx widens it by 2·dx.
  const onGripDown = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    const panel = e.currentTarget.closest('.panel')
    drag.current = { id, x: e.clientX, w: panel.getBoundingClientRect().width }
    e.currentTarget.setPointerCapture(e.pointerId)
    setMaxId(null)
  }
  const onGripMove = (e) => {
    const d = drag.current
    if (!d) return
    const w = Math.max(MIN_PANEL_W, d.w + 2 * (e.clientX - d.x))
    setWidths(prev => ({ ...prev, [d.id]: Math.round(w) }))
  }
  const onGripUp = () => { drag.current = null }

  const toggleMax = (id) => setMaxId(m => (m === id ? null : id))

  return (
    <>
      <div className="stage">
        {panels.map(p => {
          const role = roleOf(p)
          const isMax = role === 'focus' && maxId === p.id
          const style = {}
          if (p.aspect) style['--aspect'] = p.aspect
          if (widths[p.id] && role === 'focus') style['--panel-w'] = `${widths[p.id]}px`
          return (
            <section
              key={p.id}
              className={`panel panel--${role}${p.aspect ? ' panel--media' : ''}${isMax ? ' panel--max' : ''}${p.alert ? ' panel--alert' : ''}`}
              style={style}
              aria-label={p.title}
              aria-hidden={role === 'tray'}
              onClick={(e) => {
                if (role !== 'focus' && !e.target.closest('button, input, select, textarea, a')) onFocus(p.id)
              }}
            >
              <header className="panel__head" onDoubleClick={() => role === 'focus' && toggleMax(p.id)}>
                <h2 className="panel__title">{p.title}</h2>
                {p.source && <span className="panel__source">{p.source}</span>}
                <div className="panel__btns">
                  {role === 'focus' && (
                    <button className="panel__btn" onClick={() => toggleMax(p.id)}
                      title={isMax ? 'Restore size' : 'Maximise'} aria-label={isMax ? `Restore ${p.title}` : `Maximise ${p.title}`}>
                      <Icon d={isMax ? ICON_RESTORE : ICON_MAX} />
                    </button>
                  )}
                  <button className="panel__btn" onClick={() => onMinimize(p.id)} title="Put away" aria-label={`Put away ${p.title}`}>
                    <Icon d={ICON_MIN} />
                  </button>
                  <button className="panel__btn" onClick={() => onClose(p.id)} title="Close (Esc)" aria-label={`Close ${p.title}`}>
                    <Icon d={ICON_CLOSE} />
                  </button>
                </div>
              </header>
              <div className="panel__body">{p.content}</div>
              {role === 'focus' && !isMax && (
                <div className="panel__grip" title="Drag to resize" aria-hidden="true"
                  onPointerDown={(e) => onGripDown(e, p.id)} onPointerMove={onGripMove} onPointerUp={onGripUp} />
              )}
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
