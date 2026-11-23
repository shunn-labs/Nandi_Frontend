import React, { useEffect, useRef } from 'react'

/**
 * The living core: a sphere of dots drawn on a canvas that covers the main
 * area. It shows what Nandi is doing without any text or lines:
 *
 *   idle       slow rotation, gentle breathing
 *   speaking   ripples run outward with Nandi's voice level
 *   thinking   the dots swirl, the centre faster than the edge
 *   working    a few dots break away and orbit
 *   needs      the theme's attention colour, pulsing slowly (a prompt is open)
 *   offline    grey, dim and nearly still
 *
 * It moves only for Nandi. While the user talks it stays in its calm idle
 * motion — their voice is drawn as a dotted wave in the chat bar (MicWave),
 * not here. (`listening` is kept as a state name for old callers and looks
 * exactly like idle.)
 *
 * Colours come from the theme's CSS variables (--acc-rgb, --needs-rgb, --glow),
 * so light and dark and every accent just work.
 *
 * Props:
 *   state         a key of CORE_STATES
 *   mode          where it sits:
 *                   center       nothing on the stage: in the middle
 *                   dock         windows on the stage: small, in the dock slot
 *                                right of the chat bar (dockRef)
 *                   narrow-dock  the same on a phone (the slot is left of the bar)
 *                   ambient      bigger, in the middle
 *   dockRef       the element whose box the core sits in when docked. Its
 *                 rect is measured on resize, never per frame.
 *   amplitudeRef  ref holding Nandi's current voice level (0..1). A ref, so
 *                 60 level updates a second don't re-render React.
 *   anchorRefs    elements kept just under the core in the middle (hint, job
 *                 pill); their `top` is set here as the core moves
 *   onActivate    called when the core itself is clicked (centre / ambient;
 *                 when docked the slot is a button of its own)
 */
export const CORE_STATES = {
  idle:      { label: 'Standing by',       spin: 0.12 },
  listening: { label: 'Listening',         spin: 0.12 },
  speaking:  { label: 'Speaking',          spin: 0.18 },
  thinking:  { label: 'Thinking',          spin: 0.9 },
  working:   { label: 'Working',           spin: 0.35 },
  needs:     { label: 'Needs your answer', spin: 0.1 },
  offline:   { label: 'Offline',           spin: 0.02 },
}

const TAU = Math.PI * 2
const OFFLINE_RGB = [128, 138, 152]
const POINTS = fibonacciSphere(560)
// A docked core is a few dozen pixels across: 560 dots would merge into a
// blob, and skipping every other one of them leaves spiral stripes. Smaller
// spheres of their own stay evenly spread.
const POINTS_SMALL = fibonacciSphere(170)
const POINTS_MID = fibonacciSphere(300)
const DOCKED = new Set(['dock', 'narrow-dock'])

function fibonacciSphere(n) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const r = Math.sqrt(1 - y * y)
    const th = i * 2.39996
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * TAU })
  }
  return pts
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function readColours() {
  const cs = getComputedStyle(document.documentElement)
  const rgb = (name, fallback) => {
    const v = cs.getPropertyValue(name).split(',').map(Number)
    return v.length === 3 && v.every(n => !Number.isNaN(n)) ? v : fallback
  }
  return {
    acc: rgb('--acc-rgb', [47, 216, 255]),
    needs: rgb('--needs-rgb', [255, 181, 71]),
    glow: parseFloat(cs.getPropertyValue('--glow')) || 0.14,
  }
}

export default function Core({ state, mode = 'center', dockRef, amplitudeRef, anchorRefs, onActivate }) {
  const canvasRef = useRef(null)
  // Everything the animation loop reads lives in refs, so props can change
  // without restarting the loop.
  const propsRef = useRef({})
  propsRef.current = { state, mode, dockRef, amplitudeRef, anchorRefs }
  const geomRef = useRef({ x: 0, y: 0, r: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const sim = { t: 0, rot: 0, spin: 0.12, level: 0, swirl: 0, col: null, init: false, x: 0, y: 0, r: 0 }
    let colours = readColours()
    let w = 0, h = 0, dpr = 1, raf = 0, last = performance.now()
    // Resizing the backing store clears the canvas. Done from the observer it
    // landed after the frame had drawn, so the core flashed blank on every
    // resize (every frame of a layout transition). Flag it; the frame applies
    // it and draws straight after.
    let needsResize = true
    // The dock slot's centre and size relative to the canvas, re-measured only
    // when something could have moved it — never per frame.
    let slot = null, slotDirty = true, lastMode = ''

    const themeWatch = new MutationObserver(() => { colours = readColours() })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette', 'data-scheme'] })

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = rect.width; h = rect.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      needsResize = false
    }
    const measureSlot = () => {
      slotDirty = false
      const el = propsRef.current.dockRef?.current
      if (!el) { slot = null; return }
      const c = canvas.getBoundingClientRect()
      const s = el.getBoundingClientRect()
      slot = s.width && s.height
        ? { x: s.left - c.left + s.width / 2, y: s.top - c.top + s.height / 2, w: s.width, h: s.height }
        : null
    }
    const dirty = () => { needsResize = true; slotDirty = true }
    const ro = new ResizeObserver(dirty)
    ro.observe(canvas)
    const watchedSlot = propsRef.current.dockRef?.current
    if (watchedSlot) ro.observe(watchedSlot)
    window.addEventListener('resize', dirty)

    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      if (needsResize) resize()
      if (!w || !h) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const p = propsRef.current
      const st = CORE_STATES[p.state] ? p.state : 'idle'
      const k = 1 - Math.exp(-dt * 4.5)
      const speed = reduceMotion ? 0.3 : 1
      if (p.mode !== lastMode) { lastMode = p.mode; slotDirty = true }
      if (slotDirty && DOCKED.has(p.mode)) measureSlot()

      // Where the core should be.
      let tx = w / 2, ty, tr
      if (p.mode === 'ambient') { ty = h * 0.4; tr = clamp(Math.min(w, h) * 0.17, 60, 140) }
      else if (DOCKED.has(p.mode) && slot) { tx = slot.x; ty = slot.y; tr = Math.max(10, Math.min(slot.w, slot.h) * 0.34) }
      else { ty = h * 0.42; tr = clamp(Math.min(w, h) * 0.15, 56, 126) }
      if (!sim.init) Object.assign(sim, { x: tx, y: ty, r: tr, init: true })
      sim.x += (tx - sim.x) * k; sim.y += (ty - sim.y) * k; sim.r += (tr - sim.r) * k
      geomRef.current = { x: sim.x, y: sim.y, r: sim.r }

      const target = st === 'needs' ? colours.needs : st === 'offline' ? OFFLINE_RGB : colours.acc
      if (!sim.col) sim.col = target.slice()
      for (let i = 0; i < 3; i++) sim.col[i] += (target[i] - sim.col[i]) * k

      sim.t += dt * speed
      sim.spin += (CORE_STATES[st].spin - sim.spin) * k
      sim.rot += dt * sim.spin * speed
      sim.swirl += ((st === 'thinking' ? 1 : 0) - sim.swirl) * k
      // Only Nandi's voice moves it.
      const level = st === 'speaking' ? Math.min(1, p.amplitudeRef?.current || 0) : 0
      sim.level += (level - sim.level) * (1 - Math.exp(-dt * 16))

      const R = draw(ctx, dpr, w, h, sim, st, colours.glow)

      // Keep the hint and job pill just under the core while it is in the
      // middle. Compared with the element's own value, so one that was just
      // mounted (the hint comes and goes) gets its place on the next frame.
      if (!DOCKED.has(p.mode)) {
        const top = `${Math.round(sim.y + R * 1.5 + 18)}px`
        for (const ref of p.anchorRefs || []) {
          if (ref.current && ref.current.style.top !== top) ref.current.style.top = top
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      themeWatch.disconnect()
      window.removeEventListener('resize', dirty)
    }
  }, [])

  const handlePointerDown = (e) => {
    if (DOCKED.has(mode)) return
    const { x, y, r } = geomRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    if (Math.hypot(e.clientX - rect.left - x, e.clientY - rect.top - y) < r * 1.4) onActivate?.()
  }

  return (
    <canvas
      ref={canvasRef}
      className={`core core--${mode}`}
      onPointerDown={handlePointerDown}
      aria-label={`Nandi: ${(CORE_STATES[state] || CORE_STATES.idle).label}. Click the core to talk.`}
      role="img"
    />
  )
}

/** Draws one frame; returns the radius actually drawn (it breathes and pulses). */
function draw(ctx, dpr, w, h, sim, st, glow) {
  const { x, y, level } = sim
  let R = sim.r
  const [r, g, b] = sim.col.map(Math.round)
  const alpha = st === 'offline' ? 0.5 : 1
  const rgba = (a) => `rgba(${r},${g},${b},${a})`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  if (st === 'needs') R *= 1 + 0.035 * Math.sin(sim.t * 3.2)
  else if (st === 'idle' || st === 'listening') R *= 1 + 0.018 * Math.sin(sim.t * 1.1)

  // soft glow, no edges
  const gr = ctx.createRadialGradient(x, y, R * 0.1, x, y, R * 2.3)
  gr.addColorStop(0, rgba(glow * alpha * (1 + level * 1.2)))
  gr.addColorStop(1, rgba(0))
  ctx.fillStyle = gr
  ctx.beginPath(); ctx.arc(x, y, R * 2.3, 0, TAU); ctx.fill()

  const cr = Math.cos(sim.rot), sr = Math.sin(sim.rot), ct = Math.cos(0.32), stl = Math.sin(0.32)
  const dotScale = 0.55 + 0.45 * Math.min(1, R / 80)
  const points = R < 30 ? POINTS_SMALL : R < 50 ? POINTS_MID : POINTS
  for (const p of points) {
    let X = p.x * cr - p.z * sr
    const Z = p.x * sr + p.z * cr
    let Y = p.y * ct - Z * stl
    const Z2 = p.y * stl + Z * ct
    if (sim.swirl > 0.01) {
      const ang = sim.swirl * (1 - Math.hypot(X, Y)) * sim.t * 1.6
      const ca = Math.cos(ang), sa = Math.sin(ang)
      const X2 = X * ca - Y * sa
      Y = X * sa + Y * ca; X = X2
    }
    const rho = Math.min(1, Math.hypot(X, Y))
    let d = 1
    if (st === 'speaking') d += level * (0.06 + 0.2 * Math.max(0, Math.sin(rho * 11 - sim.t * 10))) * (0.35 + 0.65 * rho)
    else if (st === 'thinking') d -= 0.08 * (0.5 + 0.5 * Math.sin(sim.t * 3 + p.seed))
    else d += 0.012 * Math.sin(p.seed + sim.t * 1.4)
    const depth = (Z2 + 1) / 2
    const size = (0.55 + 1.35 * depth) * dotScale * (st === 'speaking' ? 1 + level * 0.5 * rho : 1)
    const a = (0.12 + 0.78 * depth) * alpha
    ctx.fillStyle = rgba(Math.min(1, a))
    ctx.beginPath(); ctx.arc(x + X * R * d, y + Y * R * d, size, 0, TAU); ctx.fill()
  }

  if (st === 'working') {
    for (let i = 0; i < 5; i++) {
      const ang = sim.t * (0.8 + i * 0.07) + (i * TAU) / 5
      const rr = R * (1.45 + 0.08 * Math.sin(sim.t * 2 + i))
      ctx.fillStyle = rgba(0.85 * alpha)
      ctx.beginPath()
      ctx.arc(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr * 0.55, Math.max(1.4, 2.2 * dotScale), 0, TAU)
      ctx.fill()
    }
  }
  return R
}
