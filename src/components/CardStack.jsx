import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

// How many older cards peek out behind the front one, and how far.
const PEEK = 3
const PEEK_Y = 22
const PEEK_SCALE = 0.05
// A new card does not jump to the front while you are looking through older
// ones (touched in this window); a "new card" pill appears instead.
const BROWSING_MS = 6000
const SWIPE_DISMISS_PX = 120
const SWIPE_FLIP_PX = 60
const WHEEL_STEP = 45
const WHEEL_LOCK_MS = 380
const MIN_CARD_W = 280

const Icon = ({ d }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)
const ICON = {
  close: 'M6 6l12 12M18 6L6 18',
  max: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  restore: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  stack: 'M5 9h14v11H5zM7 6h10M9 3h6',
}

/**
 * Whatever Nandi shows, as a stack of cards: the newest on top, the next few
 * peeking out behind it.
 *
 *   flip     scroll, swipe up/down, ↑/↓ (via the ref), the rail, or click a
 *            card behind
 *   dismiss  swipe sideways, ✕, or Esc (via the ref)
 *   overview "All" spreads every card into a grid; click one to bring it back
 *
 * Approvals always come to the front. Other new cards come to the front too,
 * unless you are looking through older cards; then a pill says so.
 *
 * The front card can be resized from its corner and maximised. A media card
 * keeps its picture's shape (`aspect`).
 *
 * cards  [{ id, title, source, alert, aspect, content }] newest first
 * ref:   step(±1), goTo(id), closeFront(), toggleOverview(), overview
 */
const CardStack = forwardRef(function CardStack({ cards, onClose, onClear }, ref) {
  const [frontId, setFrontId] = useState(null)
  const [overview, setOverview] = useState(false)
  const [pending, setPending] = useState(0)
  const [widths, setWidths] = useState({})
  const [maxId, setMaxId] = useState(null)

  const stackRef = useRef(null)
  const els = useRef(new Map())          // id → card element
  const prevIds = useRef([])
  const lastTouch = useRef(0)
  const frontRef = useRef(null)
  const gripDrag = useRef(null)

  const found = cards.findIndex(c => c.id === frontId)
  const idx = found >= 0 ? found : 0
  const front = cards[idx]
  frontRef.current = front ? front.id : null

  const touch = () => { lastTouch.current = Date.now() }

  // ── New cards ────────────────────────────────────────────
  useLayoutEffect(() => {
    const prev = prevIds.current
    const ids = cards.map(c => c.id)
    prevIds.current = ids
    const added = ids.filter(id => !prev.includes(id))
    if (!added.length) return
    const alert = cards.find(c => c.alert && added.includes(c.id))
    const browsing = prev.length > 0 && frontRef.current && frontRef.current !== prev[0]
      && Date.now() - lastTouch.current < BROWSING_MS
    if (alert) setFrontId(alert.id)
    else if (browsing) setPending(n => n + added.length)
    else { setFrontId(ids[0]); setPending(0) }
  }, [cards])

  useEffect(() => { if (!cards.length) { setOverview(false); setPending(0) } }, [cards.length])

  const goTo = useCallback((i) => {
    if (!cards.length) return
    const j = Math.max(0, Math.min(cards.length - 1, i))
    setFrontId(cards[j].id)
    if (j === 0) setPending(0)
  }, [cards])

  const step = useCallback((d) => { touch(); goTo(idx + d) }, [goTo, idx])

  // ── Dismissing (with a fly-out) ──────────────────────────
  const dismiss = useCallback((id, dir = 1) => {
    const el = els.current.get(id)
    const i = cards.findIndex(c => c.id === id)
    if (id === frontRef.current) {
      const next = cards[i + 1] || cards[i - 1]
      setFrontId(next ? next.id : null)
    }
    if (!el) { onClose(id); return }
    el.style.transition = 'transform .4s cubic-bezier(.4,0,.2,1), opacity .3s'
    el.style.transform = `translate(calc(-50% + ${dir * 120}%), 0) rotate(${dir * 8}deg)`
    el.style.opacity = '0'
    el.style.pointerEvents = 'none'
    setTimeout(() => onClose(id), 300)
  }, [cards, onClose])

  const toggleOverview = useCallback((on) => {
    setOverview(o => (cards.length ? (on === undefined ? !o : on) : false))
  }, [cards.length])

  useImperativeHandle(ref, () => ({
    step,
    goTo: (id) => { touch(); const i = cards.findIndex(c => c.id === id); if (i >= 0) { setOverview(false); goTo(i) } },
    closeFront: () => { if (frontRef.current) dismiss(frontRef.current, 1); return !!frontRef.current },
    toggleOverview,
    get overview() { return overview },
  }), [step, goTo, dismiss, toggleOverview, cards, overview])

  // ── Placing the cards ────────────────────────────────────
  // React renders the cards; this places them, so position changes animate
  // with CSS transitions (and dragging can write transforms directly).
  const position = useCallback(() => {
    const box = stackRef.current?.getBoundingClientRect()
    if (!box) return
    // Cards behind take the front card's size, so the stack stays one tidy
    // shape whatever each card holds (a wide picture behind a short approval).
    const frontEl = front && els.current.get(front.id)
    if (frontEl) { frontEl.style.maxHeight = ''; frontEl.style.width = '' }
    const frontH = frontEl ? frontEl.offsetHeight : 0
    const frontW = frontEl ? frontEl.offsetWidth : 0

    const cols = cards.length <= 1 ? 1 : cards.length <= 4 ? 2 : 3
    const rows = Math.ceil(cards.length / cols)
    const gap = 18
    const cellW = (box.width - gap * (cols - 1)) / cols
    const cellH = (box.height - gap * (rows - 1)) / rows

    cards.forEach((c, i) => {
      const el = els.current.get(c.id)
      if (!el) return
      if (el.dataset.fresh) {
        // First paint: start just below the front card, then animate into place.
        el.style.transition = 'none'
        el.style.opacity = '0'
        el.style.transform = 'translate(-50%, 36px) scale(.94)'
        void el.offsetWidth
        delete el.dataset.fresh
      }
      el.style.transition = ''
      let transform, opacity = 1, z = 100 - Math.abs(i - idx), maxH = '', width = '', events = ''
      if (overview) {
        el.style.maxHeight = ''
        el.style.width = ''
        const w = el.offsetWidth, h = Math.min(el.offsetHeight, box.height)
        const s = Math.min(cellW / w, cellH / h, 1)
        const col = i % cols, row = Math.floor(i / cols)
        const dx = col * (cellW + gap) + cellW / 2 - box.width / 2
        const top = row * (cellH + gap) + (cellH - h * s) / 2
        transform = `translate(calc(-50% + ${dx}px), ${top}px) scale(${s})`
        z = 100 - i
      } else {
        const r = i - idx
        if (r < 0) { transform = `translate(-50%, ${-40 - 10 * Math.min(3, -r)}px) scale(1.02)`; opacity = 0; events = 'none' }
        else if (r === 0) transform = 'translate(-50%, 0) scale(1)'
        else if (r <= PEEK) { transform = `translate(-50%, ${-r * PEEK_Y}px) scale(${1 - r * PEEK_SCALE})`; opacity = 1 - r * 0.2 }
        else { transform = `translate(-50%, ${-(PEEK + 0.5) * PEEK_Y}px) scale(${1 - (PEEK + 1) * PEEK_SCALE})`; opacity = 0; events = 'none' }
        if (r > 0) { maxH = `${frontH}px`; width = `${frontW}px` }
      }
      el.style.transform = transform
      el.style.opacity = String(opacity)
      el.style.zIndex = String(z)
      el.style.maxHeight = maxH
      el.style.width = width
      el.style.pointerEvents = events
    })
  }, [cards, idx, front, overview])

  useLayoutEffect(() => { position() })
  useEffect(() => {
    const ro = new ResizeObserver(() => position())
    if (stackRef.current) ro.observe(stackRef.current)
    const frontEl = front && els.current.get(front.id)
    if (frontEl) ro.observe(frontEl)
    return () => ro.disconnect()
  }, [position, front])

  // ── Scroll to flip ───────────────────────────────────────
  const wheel = useRef({ acc: 0, lock: 0 })
  useEffect(() => {
    const el = stackRef.current?.parentElement
    if (!el) return undefined
    const onWheel = (e) => {
      if (overview || !cards.length) return
      // A long card scrolls itself first; only past its end does the stack flip.
      const body = e.target.closest('.card__body')
      if (body && body.scrollHeight > body.clientHeight + 4) {
        const atTop = body.scrollTop <= 0
        const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2
        if (!(e.deltaY < 0 && atTop) && !(e.deltaY > 0 && atEnd)) return
      }
      e.preventDefault()
      const now = performance.now()
      if (now < wheel.current.lock) return
      wheel.current.acc += e.deltaY
      if (Math.abs(wheel.current.acc) > WHEEL_STEP) {
        step(Math.sign(wheel.current.acc))
        wheel.current = { acc: 0, lock: now + WHEEL_LOCK_MS }
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [overview, cards.length, step])

  // ── Swipe: sideways dismisses, up/down flips ─────────────
  const swipe = useRef(null)
  const onPointerDown = (e, c) => {
    if (overview || c.id !== frontRef.current || e.button !== 0) return
    if (e.target.closest('button, input, select, textarea, a, video, .card__grip')) return
    // A selection or a draggable image would start the browser's own drag,
    // which cancels the pointer (pointercancel) after the first move.
    window.getSelection()?.removeAllRanges()
    if (e.pointerType === 'mouse') e.preventDefault()
    swipe.current = { id: c.id, x: e.clientX, y: e.clientY, dx: 0, dy: 0, axis: '' }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    const s = swipe.current
    if (!s) return
    s.dx = e.clientX - s.x; s.dy = e.clientY - s.y
    if (!s.axis && Math.hypot(s.dx, s.dy) > 8) s.axis = Math.abs(s.dx) > Math.abs(s.dy) ? 'x' : 'y'
    if (!s.axis) return
    const el = e.currentTarget
    el.style.transition = 'none'
    if (s.axis === 'x') {
      el.style.transform = `translate(calc(-50% + ${s.dx}px), 0) rotate(${s.dx / 40}deg)`
      el.style.opacity = String(1 - Math.min(0.6, Math.abs(s.dx) / 500))
    } else {
      el.style.transform = `translate(-50%, ${s.dy * 0.6}px)`
    }
  }
  const onPointerUp = () => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    touch()
    if (s.axis === 'x' && Math.abs(s.dx) > SWIPE_DISMISS_PX) dismiss(s.id, Math.sign(s.dx))
    else if (s.axis === 'y' && s.dy < -SWIPE_FLIP_PX) step(1)
    else if (s.axis === 'y' && s.dy > SWIPE_FLIP_PX) step(-1)
    else position()
  }

  // ── Resize from the corner (the card is centred, so dx widens it by 2·dx) ──
  const onGripDown = (e, id) => {
    e.preventDefault(); e.stopPropagation()
    gripDrag.current = { id, x: e.clientX, w: e.currentTarget.closest('.card').getBoundingClientRect().width }
    e.currentTarget.setPointerCapture(e.pointerId)
    setMaxId(null)
  }
  const onGripMove = (e) => {
    const d = gripDrag.current
    if (!d) return
    const w = Math.max(MIN_CARD_W, d.w + 2 * (e.clientX - d.x))
    setWidths(prev => ({ ...prev, [d.id]: Math.round(w) }))
  }
  const onGripUp = () => { gripDrag.current = null }

  const onCardClick = (e, c, i) => {
    if (e.target.closest('button, input, select, textarea, a')) return
    if (overview) { setOverview(false); goTo(i); return }
    if (i !== idx) { touch(); goTo(i) }
  }

  if (!cards.length) return null

  return (
    <section className={`cards${overview ? ' cards--overview' : ''}`} aria-roledescription="card stack" aria-label="What Nandi is showing">
      <div className="cards__head">
        <span className="cards__count">
          {overview ? <><b>{cards.length}</b> on screen</> : <><b>{idx + 1}</b> of {cards.length}</>}
        </span>
        <span className="cards__spacer" />
        <button className={`cards__btn${overview ? ' cards__btn--on' : ''}`} onClick={() => toggleOverview()} title="See all cards (O)">
          <Icon d={overview ? ICON.stack : ICON.grid} />{overview ? 'Stack' : 'All'}
        </button>
        <button className="cards__btn" onClick={onClear} title="Clear the screen (Esc Esc)">Clear</button>
      </div>

      <button className={`cards__new${pending > 0 ? ' cards__new--on' : ''}`} onClick={() => { setPending(0); goTo(0) }}>
        ↑ {pending === 1 ? '1 new card' : `${pending} new cards`}
      </button>

      <div className="cards__stack" ref={stackRef}>
        {cards.map((c, i) => {
          const isFront = !overview && i === idx
          const isMax = isFront && maxId === c.id
          const style = {}
          if (c.aspect) style['--aspect'] = c.aspect
          if (widths[c.id]) style['--card-w'] = `${widths[c.id]}px`
          return (
            <article
              key={c.id}
              ref={(el) => {
                if (el && !els.current.has(c.id)) el.dataset.fresh = '1'
                if (el) els.current.set(c.id, el); else els.current.delete(c.id)
              }}
              className={`card${c.aspect ? ' card--media' : ''}${c.alert ? ' card--alert' : ''}${isFront ? ' card--front' : ''}${!overview && i > idx ? ' card--behind' : ''}${isMax ? ' card--max' : ''}`}
              style={style}
              aria-label={c.title}
              aria-hidden={!overview && !isFront}
              onClick={(e) => onCardClick(e, c, i)}
              onPointerDown={(e) => onPointerDown(e, c)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <header className="card__head" onDoubleClick={() => isFront && setMaxId(m => (m === c.id ? null : c.id))}>
                <i className="card__dot" />
                <h2 className="card__title">{c.title}</h2>
                {c.source && <span className="card__source" title={c.source}>{c.source}</span>}
                <div className="card__btns">
                  {isFront && (
                    <button className="card__btn" onClick={() => setMaxId(m => (m === c.id ? null : c.id))}
                      title={isMax ? 'Restore size' : 'Maximise'} aria-label={isMax ? `Restore ${c.title}` : `Maximise ${c.title}`}>
                      <Icon d={isMax ? ICON.restore : ICON.max} />
                    </button>
                  )}
                  <button className="card__btn" onClick={() => dismiss(c.id, 1)} title="Dismiss (Esc)" aria-label={`Dismiss ${c.title}`}>
                    <Icon d={ICON.close} />
                  </button>
                </div>
              </header>
              <div className="card__body">{c.content}</div>
              {isFront && !isMax && (
                <div className="card__grip" title="Drag to resize" aria-hidden="true"
                  onPointerDown={(e) => onGripDown(e, c.id)} onPointerMove={onGripMove} onPointerUp={onGripUp} />
              )}
            </article>
          )
        })}
      </div>

      {!overview && (
        <nav className="cards__rail" aria-label="Cards">
          <button className="cards__arrow" onClick={() => step(-1)} disabled={idx === 0} aria-label="Newer card"><Icon d={ICON.up} /></button>
          {cards.map((c, i) => (
            <button key={c.id} className={`cards__pip${i === idx ? ' cards__pip--on' : ''}${c.alert ? ' cards__pip--alert' : ''}`}
              onClick={() => { touch(); goTo(i) }} aria-label={c.title} aria-current={i === idx}>
              <span>{c.title}</span>
            </button>
          ))}
          <button className="cards__arrow" onClick={() => step(1)} disabled={idx >= cards.length - 1} aria-label="Older card"><Icon d={ICON.down} /></button>
        </nav>
      )}

      <p className="cards__hint">Scroll or <kbd>↑</kbd><kbd>↓</kbd> to flip · swipe sideways to dismiss · <kbd>O</kbd> all cards</p>
    </section>
  )
})

export default CardStack
