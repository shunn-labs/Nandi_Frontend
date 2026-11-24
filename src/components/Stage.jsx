import React, {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { HEAD, layoutTiles, tileSpec } from '../lib/tiling.js'

const GAP = 10
const LEAVE_MS = 180          // the fade-out before a closed window is removed
const DRAG_PX = 4             // a press that moves less than this is a click
const MIN_W = 200
const MIN_H = HEAD + 90
const KEEP_VISIBLE = 80       // px of a dragged window that must stay on the stage

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

const Icon = ({ d }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)
const ICON = {
  close: 'M6 6l12 12M18 6L6 18',
  max: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  restore: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
}

/**
 * The stage: everything Nandi shows, as pop-up windows that share the space.
 *
 *   auto      windows tile themselves to use the whole stage (lib/tiling.js):
 *             one fills it, a second halves it, more re-flow into rows
 *   manual    drag a title bar to move a window, its corner to resize it; it
 *             then stays where you put it, floating, while the others keep
 *             filling the stage. Auto-arrange (O) puts every window back.
 *   maximise  the button or a double-click on the title bar
 *   close     ✕ (Esc closes the front window; Esc Esc clears the stage)
 *
 * Narrow screens get a scrolling list instead (no dragging).
 *
 * Why it does not blink: windows are memoised on their item (useStageItems
 * keeps an unchanged item the same object), keyed by id and rendered in the
 * order they first appeared — never re-sorted, because moving a DOM node
 * reloads an iframe (a PDF) and restarts media. Front-to-back is z-index only.
 * The entrance is a CSS animation that runs once, when the node mounts.
 *
 * items           [{ id, kind, aspect, title, source, alert, ... }] (useStageItems)
 * renderContent   item → the window's body (memoised per item)
 * onClose(id), onClear()
 * onArrangedChange(bool)  true while a window is moved/resized by hand or
 *                         maximised (so Auto-arrange is worth offering)
 * ref             closeTop() → bool, focus(id), autoArrange()
 */
const Stage = forwardRef(function Stage({ items, renderContent, onClose, onClear, narrow, onArrangedChange }, ref) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [manual, setManual] = useState({})          // id → { x, y, w, h, W, H } (px at stage size W×H)
  const [maxId, setMaxId] = useState(null)
  const [zOrder, setZOrder] = useState([])          // back → front
  const [leaving, setLeaving] = useState(() => new Set())

  // ── The order windows first appeared in (render and tiling order) ──
  const orderRef = useRef([])
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const ordered = useMemo(() => {
    const kept = orderRef.current.filter(id => byId.has(id))
    const seen = new Set(kept)
    for (const it of items) if (!seen.has(it.id)) { kept.push(it.id); seen.add(it.id) }
    orderRef.current = kept
    return kept.map(id => byId.get(id))
  }, [items, byId])
  const idsKey = ordered.map(i => i.id).join('\n')

  // ── Stage size ──
  useLayoutEffect(() => {
    const el = rootRef.current
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(s => (Math.abs(s.w - width) < 0.5 && Math.abs(s.h - height) < 0.5 ? s : { w: width, h: height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Windows coming and going ──
  const prevIds = useRef([])
  useLayoutEffect(() => {
    const ids = ordered.map(i => i.id)
    const now = new Set(ids)
    const before = new Set(prevIds.current)
    const added = ids.filter(id => !before.has(id))
    prevIds.current = ids
    // New windows pop up in front; a maximised window makes way so they are seen.
    setZOrder(z => {
      const kept = z.filter(id => now.has(id))
      return added.length || kept.length !== z.length ? [...kept, ...added] : z
    })
    if (added.length) setMaxId(null)
    else setMaxId(m => (m && !now.has(m) ? null : m))
    setManual(m => {
      const gone = Object.keys(m).filter(id => !now.has(id))
      if (!gone.length) return m
      const next = { ...m }
      for (const id of gone) delete next[id]
      return next
    })
    setLeaving(l => {
      const gone = [...l].filter(id => !now.has(id))
      if (!gone.length) return l
      const next = new Set(l)
      for (const id of gone) next.delete(id)
      return next
    })
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // An approval that opens comes to the front, un-maximising the stage.
  const alertKey = ordered.filter(i => i.alert).map(i => i.id).join('\n')
  const prevAlerts = useRef('')
  useLayoutEffect(() => {
    const before = new Set(prevAlerts.current.split('\n'))
    prevAlerts.current = alertKey
    const fresh = alertKey ? alertKey.split('\n').filter(id => !before.has(id)) : []
    if (!fresh.length) return
    setMaxId(null)
    setZOrder(z => [...z.filter(id => !fresh.includes(id)), ...fresh])
  }, [alertKey])

  // ── Auto layout (memoised on what changes it) ──
  const specKey = ordered.map(i => `${i.id}|${i.kind}|${i.aspect ? i.aspect.toFixed(3) : ''}`).join('\n')
  const manualKey = Object.keys(manual).sort().join('\n')
  const layout = useMemo(() => {
    if (narrow) return null
    const auto = ordered.filter(i => !manual[i.id]).map(tileSpec)
    return layoutTiles(auto, size, { gap: GAP })
  }, [narrow, size, specKey, manualKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const contentH = layout ? Math.max(size.h, layout.contentH) : size.h

  // ── What the windows (memoised) call: one stable object ──
  const live = useRef({})
  live.current = { size, contentH, zOrder, onClose, ordered, leaving }
  const api = useMemo(() => ({
    bounds: () => ({ w: live.current.size.w, h: live.current.contentH }),
    focus: (id) => setZOrder(z => (z[z.length - 1] === id ? z : [...z.filter(x => x !== id), id])),
    toggleMax: (id) => {
      setMaxId(m => (m === id ? null : id))
      setZOrder(z => (z[z.length - 1] === id ? z : [...z.filter(x => x !== id), id]))
      rootRef.current?.scrollTo?.({ top: 0 })
    },
    close: (id) => {
      setLeaving(l => new Set(l).add(id))
      setTimeout(() => live.current.onClose(id), LEAVE_MS)
    },
    // Called when a drag or resize starts: the window becomes manual at the
    // rect it has now, so a re-tile mid-drag cannot move it.
    beginManual: (id, r) => {
      const { w: W, h: H } = live.current.size
      setManual(m => ({ ...m, [id]: { ...r, W, H } }))
      setMaxId(m => (m === id ? null : m))
    },
    commitManual: (id, r) => {
      const { w: W, h: H } = live.current.size
      setManual(m => ({ ...m, [id]: { ...r, W, H } }))
    },
  }), [])

  const autoArrange = useCallback(() => { setManual({}); setMaxId(null) }, [])

  useImperativeHandle(ref, () => ({
    closeTop: () => {
      const { zOrder: z, ordered: list, leaving: l } = live.current
      const open = new Set(list.map(i => i.id))
      const top = [...z].reverse().find(id => open.has(id) && !l.has(id))
      if (!top) return false
      api.close(top)
      return true
    },
    focus: (id) => {
      api.focus(id)
      const el = rootRef.current?.querySelector(`[data-win="${CSS.escape(id)}"]`)
      el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    },
    autoArrange,
  }), [api, autoArrange])

  const arranged = !!maxId || manualKey !== ''
  useEffect(() => { onArrangedChange?.(arranged) }, [arranged, onArrangedChange])

  // A window's rect: maximised, manual (scaled to the stage's current size), or tiled.
  const rectOf = (id) => {
    if (maxId === id) return { x: 0, y: rootRef.current?.scrollTop || 0, w: size.w, h: size.h }
    const m = manual[id]
    if (m) {
      const sx = m.W ? size.w / m.W : 1, sy = m.H ? size.h / m.H : 1
      const w = clamp(m.w * sx, MIN_W, Math.max(MIN_W, size.w))
      const h = clamp(m.h * sy, MIN_H, Math.max(MIN_H, contentH))
      return { x: clamp(m.x * sx, KEEP_VISIBLE - w, size.w - KEEP_VISIBLE), y: clamp(m.y * sy, 0, Math.max(0, contentH - HEAD)), w, h }
    }
    return layout?.rects.get(id) || { x: 0, y: 0, w: Math.min(size.w, 480), h: Math.min(size.h, 320) }
  }

  const empty = ordered.length === 0
  return (
    <div ref={rootRef} className={`stage${narrow ? ' stage--list' : ''}${layout?.overflow ? ' stage--scroll' : ''}${empty ? ' stage--empty' : ''}`}
      aria-label="What Nandi is showing" aria-hidden={empty}>
      <div className="stage__inner" style={narrow ? undefined : { height: contentH }}>
        {ordered.map((item, i) => {
          const r = narrow ? null : rectOf(item.id)
          const z = 10 + Math.max(0, zOrder.indexOf(item.id)) + (maxId === item.id ? 100 : 0)
          return (
            <StageWindow
              key={item.id}
              item={item}
              x={r ? Math.round(r.x) : 0}
              y={r ? Math.round(r.y) : 0}
              w={r ? Math.round(r.w) : 0}
              h={r ? Math.round(r.h) : 0}
              z={z}
              order={narrow ? -i : 0}
              isMax={maxId === item.id}
              isManual={!!manual[item.id]}
              leaving={leaving.has(item.id)}
              narrow={!!narrow}
              renderContent={renderContent}
              api={api}
            />
          )
        })}
      </div>
    </div>
  )
})

/**
 * One window. Re-renders only when its item, rect, z or flags change; its
 * body (renderContent) only when its item changes. Dragging writes the DOM
 * directly and commits to state on release, so nothing re-renders per move.
 */
const StageWindow = memo(function StageWindow({ item, x, y, w, h, z, order, isMax, isManual, leaving, narrow, renderContent, api }) {
  const elRef = useRef(null)
  const drag = useRef(null)
  const content = useMemo(() => renderContent(item), [renderContent, item])

  // ── Move by the title bar ──
  const onHeadDown = (e) => {
    if (narrow || isMax || e.button !== 0 || e.target.closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode: 'move', sx: e.clientX, sy: e.clientY, x, y, w, h, nx: x, ny: y, moved: false }
  }
  // ── Resize by the corner ──
  const onGripDown = (e) => {
    if (narrow || e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode: 'size', sx: e.clientX, sy: e.clientY, x, y, w, h, nw: w, nh: h, moved: false,
                     aspect: Math.max(0.1, w / Math.max(1, h - HEAD)) }
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return
      d.moved = true
      elRef.current.dataset.moving = '1'      // no transition while dragging (not a React-managed attribute)
      api.beginManual(item.id, { x: d.x, y: d.y, w: d.w, h: d.h })
    }
    const b = api.bounds()
    const el = elRef.current
    if (d.mode === 'move') {
      d.nx = clamp(d.x + dx, KEEP_VISIBLE - d.w, b.w - KEEP_VISIBLE)
      d.ny = clamp(d.y + dy, 0, Math.max(0, b.h - HEAD))
      el.style.transform = `translate3d(${Math.round(d.nx)}px, ${Math.round(d.ny)}px, 0)`
    } else {
      let nw = clamp(d.w + dx, MIN_W, Math.max(MIN_W, b.w - d.x))
      let nh
      if (item.kind === 'media' && !e.shiftKey) {
        // A picture keeps its shape unless Shift is held.
        nh = nw / d.aspect + HEAD
        const room = Math.max(MIN_H, b.h - d.y)
        if (nh > room) { nh = room; nw = (nh - HEAD) * d.aspect }
      } else {
        nh = clamp(d.h + dy, MIN_H, Math.max(MIN_H, b.h - d.y))
      }
      d.nw = nw; d.nh = nh
      el.style.width = `${Math.round(nw)}px`
      el.style.height = `${Math.round(nh)}px`
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    delete elRef.current.dataset.moving
    const r = d.mode === 'move'
      ? { x: Math.round(d.nx), y: Math.round(d.ny), w: d.w, h: d.h }
      : { x: d.x, y: d.y, w: Math.round(d.nw), h: Math.round(d.nh) }
    api.commitManual(item.id, r)
  }

  const style = narrow
    ? { order, '--aspect': item.kind === 'media' && item.aspect ? item.aspect : undefined }
    : { transform: `translate3d(${x}px, ${y}px, 0)`, width: `${w}px`, height: `${h}px`, zIndex: z }

  return (
    <section
      ref={elRef}
      data-win={item.id}
      className={`win win--${item.kind}${item.alert ? ' win--alert' : ''}${isMax ? ' win--max' : ''}${isManual ? ' win--manual' : ''}${leaving ? ' win--leaving' : ''}`}
      style={style}
      aria-label={item.title}
      onPointerDownCapture={() => api.focus(item.id)}
    >
      <header className="win__head"
        onPointerDown={onHeadDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={(e) => { if (!narrow && !e.target.closest('button')) api.toggleMax(item.id) }}>
        <i className="win__dot" />
        <h2 className="win__title" title={item.title}>{item.title}</h2>
        {item.source && <span className="win__source" title={item.source}>{item.source}</span>}
        <div className="win__btns">
          {!narrow && (
            <button className="win__btn" onClick={() => api.toggleMax(item.id)}
              title={isMax ? 'Restore size' : 'Maximise'} aria-label={isMax ? `Restore ${item.title}` : `Maximise ${item.title}`}>
              <Icon d={isMax ? ICON.restore : ICON.max} />
            </button>
          )}
          <button className="win__btn" onClick={() => api.close(item.id)} title="Close (Esc)" aria-label={`Close ${item.title}`}>
            <Icon d={ICON.close} />
          </button>
        </div>
      </header>
      <div className="win__body">{content}</div>
      {!narrow && !isMax && (
        <div className="win__grip" title="Drag to resize (Shift: free shape)" aria-hidden="true"
          onPointerDown={onGripDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      )}
    </section>
  )
})

export default Stage
