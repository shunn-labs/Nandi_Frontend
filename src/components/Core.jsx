import React, { useEffect, useRef } from 'react'

/**
 * The living core: a sphere of dots drawn on a canvas that fills the voice
 * column. It shows what Nandi is doing without any text or lines:
 *
 *   idle       slow rotation, gentle breathing
 *   listening  opens up and brightens; ripples run inward with the mic level
 *   speaking   ripples run outward with the voice level
 *   thinking   the dots swirl, the centre faster than the edge
 *   working    a few dots break away and orbit
 *   needs      the theme's attention colour, pulsing slowly (a prompt is open)
 *   offline    grey, dim and nearly still
 *
 * Colours come from the theme's CSS variables (--acc-rgb, --needs-rgb, --glow),
 * so light and dark and every accent just work.
 *
 * Props:
 *   state         a key of CORE_STATES
 *   hasCards      cards are on screen: the core sits higher in its column, or
 *                 shrinks to the top on narrow screens where the cards cover it
 *   large         ambient mode: a bigger core
 *   amplitudeRef  ref holding the current mic / voice level (0..1). A ref, so
 *                 60 level updates a second don't re-render React.
 *   anchorRefs    elements kept just under the core (hint, job pill); their
 *                 `top` is set here as the core moves
 *   onActivate    called when the core itself is clicked
 */
export const CORE_STATES = {
  idle:      { label: 'Standing by',       spin: 0.12 },
  listening: { label: 'Listening',         spin: 0.2 },
  speaking:  { label: 'Speaking',          spin: 0.18 },
  thinking:  { label: 'Thinking',          spin: 0.9 },
  working:   { label: 'Working',           spin: 0.35 },
  needs:     { label: 'Needs your answer', spin: 0.1 },
  offline:   { label: 'Offline',           spin: 0.02 },
}

const TAU = Math.PI * 2
const OFFLINE_RGB = [128, 138, 152]
const NARROW_PX = 820
const POINTS = fibonacciSphere(560)

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

export default function Core({ state, hasCards, large, amplitudeRef, anchorRefs, onActivate }) {
  const canvasRef = useRef(null)
  // Everything the animation loop reads lives in refs, so props can change
  // without restarting the loop.
  const propsRef = useRef({})
  propsRef.current = { state, hasCards, large, amplitudeRef, anchorRefs }
  const geomRef = useRef({ x: 0, y: 0, r: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const sim = { t: 0, rot: 0, spin: 0.12, level: 0, swirl: 0, col: null, init: false, x: 0, y: 0, r: 0 }
    let colours = readColours()
    let w = 0, h = 0, dpr = 1, raf = 0, last = performance.now(), anchorTop = null

    // Re-read the theme's colours whenever the accent or light/dark changes.
    const themeWatch = new MutationObserver(() => { colours = readColours() })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette', 'data-scheme'] })

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = rect.width; h = rect.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      if (!w || !h) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const p = propsRef.current
      const st = CORE_STATES[p.state] ? p.state : 'idle'
      const k = 1 - Math.exp(-dt * 4.5)
      const speed = reduceMotion ? 0.3 : 1

      // Where the core should be.
      let tx = w / 2, ty, tr
      if (p.large) { ty = h * 0.4; tr = clamp(Math.min(w, h) * 0.17, 60, 140) }
      else if (p.hasCards && window.innerWidth <= NARROW_PX) { ty = 46; tr = 24 }
      else if (p.hasCards) { ty = h * 0.36; tr = clamp(Math.min(w, h) * 0.24, 56, 104) }
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
      const level = st === 'listening' || st === 'speaking' ? Math.min(1, p.amplitudeRef?.current || 0) : 0
      sim.level += (level - sim.level) * (1 - Math.exp(-dt * 16))

      const R = draw(ctx, dpr, w, h, sim, st, colours.glow)

      // Keep the hint and job pill just under the core.
      const top = Math.round(sim.y + R * 1.5 + 18)
      if (top !== anchorTop) {
        anchorTop = top
        for (const ref of p.anchorRefs || []) if (ref.current) ref.current.style.top = `${top}px`
      }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); themeWatch.disconnect() }
  }, [])

  const handlePointerDown = (e) => {
    const { x, y, r } = geomRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    if (Math.hypot(e.clientX - rect.left - x, e.clientY - rect.top - y) < r * 1.4) onActivate?.()
  }

  return (
    <canvas
      ref={canvasRef}
      className="core"
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

  if (st === 'listening') R *= 1.06 + level * 0.06
  else if (st === 'needs') R *= 1 + 0.035 * Math.sin(sim.t * 3.2)
  else if (st === 'idle') R *= 1 + 0.018 * Math.sin(sim.t * 1.1)

  // soft glow, no edges
  const gr = ctx.createRadialGradient(x, y, R * 0.1, x, y, R * 2.3)
  gr.addColorStop(0, rgba(glow * alpha * (1 + level * 1.2)))
  gr.addColorStop(1, rgba(0))
  ctx.fillStyle = gr
  ctx.beginPath(); ctx.arc(x, y, R * 2.3, 0, TAU); ctx.fill()

  const cr = Math.cos(sim.rot), sr = Math.sin(sim.rot), ct = Math.cos(0.32), stl = Math.sin(0.32)
  const dotScale = 0.55 + 0.45 * (R / 80)
  for (const p of POINTS) {
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
    else if (st === 'listening') d += level * 0.16 * Math.sin(rho * 9 + sim.t * 8) * rho - 0.02
    else if (st === 'thinking') d -= 0.08 * (0.5 + 0.5 * Math.sin(sim.t * 3 + p.seed))
    else d += 0.012 * Math.sin(p.seed + sim.t * 1.4)
    const depth = (Z2 + 1) / 2
    const size = (0.55 + 1.35 * depth) * dotScale * (st === 'speaking' ? 1 + level * 0.5 * rho : 1)
    const a = (0.12 + 0.78 * depth) * alpha * (st === 'listening' ? 0.85 + level * 0.3 : 1)
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
