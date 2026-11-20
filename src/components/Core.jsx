import React, { useEffect, useRef } from 'react'
import { THEMES } from '../lib/themes.js'

/**
 * The living core: a particle sphere drawn on a canvas that fills the stage.
 *
 * It shows what Nandi is doing without any text:
 *   idle       slow breathing
 *   listening  follows the microphone level
 *   thinking   spins faster, with a sweeping tick ring
 *   working    small satellites orbit it while a job runs
 *   speaking   follows the voice level
 *   needs      turns the theme's attention colour and pulses (a prompt is open)
 *   offline    dims and slows down
 *
 * Props:
 *   state         one of the keys of CORE_STATES
 *   compact       true while a panel is in focus: the core shrinks to the top
 *   large         ambient mode: a bigger core in the middle
 *   theme         key of THEMES, for the colours
 *   amplitudeRef  ref holding the current mic / voice level (0..1). A ref, not
 *                 a prop, so 60 level updates a second don't re-render React.
 *   onActivate    called when the core itself is clicked
 */
export const CORE_STATES = {
  idle:      { label: 'Standing by',       spin: 0.2,  ring: 0.2 },
  listening: { label: 'Listening',         spin: 0.4,  ring: 0.6 },
  thinking:  { label: 'Thinking',          spin: 1.5,  ring: 2.0 },
  working:   { label: 'Working',           spin: 0.7,  ring: 1.0 },
  speaking:  { label: 'Speaking',          spin: 0.45, ring: 0.7 },
  needs:     { label: 'Needs your answer', spin: 0.25, ring: 0.3 },
  offline:   { label: 'Offline',           spin: 0.03, ring: 0.03 },
}

const TAU = Math.PI * 2
const OFFLINE_RGB = [100, 114, 138]
const POINTS = fibonacciSphere(190)

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

export default function Core({ state, compact, large, theme, amplitudeRef, onActivate }) {
  const canvasRef = useRef(null)
  // Everything the animation loop reads lives in one ref, so props can change
  // without restarting the loop.
  const propsRef = useRef({})
  propsRef.current = { state, compact, large, theme, amplitudeRef }
  const geomRef = useRef({ x: 0, y: 0, r: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const sim = { t: 0, rot: 0, ringA: 0, spin: 0.2, ring: 0.2, amp: 0, tick: 0, col: null, init: false, ...geomRef.current }
    let w = 0, h = 0, dpr = 1, raf = 0, last = performance.now()

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
      const S = CORE_STATES[p.state] || CORE_STATES.idle
      const T = THEMES[p.theme] || THEMES.ion
      const k = 1 - Math.exp(-dt * 5)
      const speed = reduceMotion ? 0.3 : 1

      // Where the core should be: centre, top (compact) or big (ambient).
      const tx = w / 2
      const ty = p.large ? h * 0.4 : p.compact ? 34 : h * 0.44
      const tr = p.large ? clamp(Math.min(w, h) * 0.16, 60, 140)
        : p.compact ? 17 : clamp(Math.min(w, h) * 0.11, 40, 96)
      if (!sim.init) { Object.assign(sim, { x: tx, y: ty, r: tr, init: true }) }
      sim.x += (tx - sim.x) * k; sim.y += (ty - sim.y) * k; sim.r += (tr - sim.r) * k
      geomRef.current = { x: sim.x, y: sim.y, r: sim.r }

      const target = p.state === 'needs' ? T.needs : p.state === 'offline' ? OFFLINE_RGB : T.core
      if (!sim.col) sim.col = target.slice()
      for (let i = 0; i < 3; i++) sim.col[i] += (target[i] - sim.col[i]) * k

      sim.t += dt * speed
      sim.spin += (S.spin - sim.spin) * k
      sim.ring += (S.ring - sim.ring) * k
      sim.tick += ((p.state === 'thinking' ? 1 : 0) - sim.tick) * k
      sim.rot += dt * sim.spin * speed
      sim.ringA += dt * sim.ring * speed

      const level = p.amplitudeRef?.current || 0
      const ampTarget = p.state === 'listening' || p.state === 'speaking' ? Math.min(1, level)
        : p.state === 'thinking' ? 0.12
        : 0.035 + 0.025 * Math.sin(sim.t * 1.2)
      sim.amp += (ampTarget - sim.amp) * (1 - Math.exp(-dt * 14))

      draw(ctx, dpr, w, h, sim, p.state)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  const handlePointerDown = (e) => {
    const { x, y, r } = geomRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    if (Math.hypot(e.clientX - rect.left - x, e.clientY - rect.top - y) < r * 1.5) onActivate?.()
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

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

function draw(ctx, dpr, w, h, sim, state) {
  const { x, y, r: R, amp } = sim
  const [r, g, b] = sim.col.map(Math.round)
  const alpha = state === 'offline' ? 0.5 : 1
  const rgba = (a) => `rgba(${r},${g},${b},${a})`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // soft glow
  let gr = ctx.createRadialGradient(x, y, R * 0.2, x, y, R * 2.6)
  gr.addColorStop(0, rgba(0.16 * alpha * (1 + amp)))
  gr.addColorStop(1, rgba(0))
  ctx.fillStyle = gr
  ctx.beginPath(); ctx.arc(x, y, R * 2.6, 0, TAU); ctx.fill()

  // tick ring, only while thinking
  if (sim.tick > 0.02) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(sim.ringA * 0.25)
    const sweep = (sim.t * 2.6) % TAU
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * TAU
      const d = Math.abs(((ang - sweep + TAU * 1.5) % TAU) - Math.PI)
      const a = (0.12 + Math.max(0, 0.8 - (Math.PI - d) * 1.1)) * sim.tick * alpha
      const r1 = R * 1.55, r2 = r1 + R * 0.07
      ctx.strokeStyle = rgba(a); ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1)
      ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2)
      ctx.stroke()
    }
    ctx.restore()
  }

  // two quiet orbit arcs
  for (let j = 0; j < 2; j++) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(sim.ringA * (j ? -1.3 : 1) + j * 2)
    ctx.strokeStyle = rgba((j ? 0.16 : 0.32) * alpha); ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(0, 0, R * (1.22 + j * 0.14), 0, TAU * (j ? 0.55 : 0.72)); ctx.stroke()
    ctx.restore()
  }

  // particle sphere
  const cr = Math.cos(sim.rot), sr = Math.sin(sim.rot), ct = Math.cos(0.38), st = Math.sin(0.38)
  for (const p of POINTS) {
    const X = p.x * cr - p.z * sr, Z = p.x * sr + p.z * cr
    const Y2 = p.y * ct - Z * st, Z2 = p.y * st + Z * ct
    let d = 1 + amp * 0.5 * Math.sin(p.seed + sim.t * 5 + p.y * 3)
    if (state === 'thinking') d -= 0.12 * (0.5 + 0.5 * Math.sin(sim.t * 3 + p.seed))
    const depth = (Z2 + 1) / 2
    const size = (0.5 + 1.1 * depth) * (R / 70 + 0.35)
    ctx.fillStyle = rgba((0.1 + 0.65 * depth) * alpha)
    ctx.fillRect(x + X * R * d - size / 2, y + Y2 * R * d - size / 2, size, size)
  }

  // bright centre
  gr = ctx.createRadialGradient(x, y, 0, x, y, R * 0.6)
  gr.addColorStop(0, `rgba(255,255,255,${0.85 * alpha})`)
  gr.addColorStop(0.35, rgba(0.42 * alpha * (1 + amp)))
  gr.addColorStop(1, rgba(0))
  ctx.fillStyle = gr
  ctx.beginPath(); ctx.arc(x, y, R * 0.6 * (1 + amp * 0.25), 0, TAU); ctx.fill()

  // waiting for an answer: a slow outward pulse
  if (state === 'needs') {
    const ph = (sim.t % 1.8) / 1.8
    ctx.strokeStyle = rgba((1 - ph) * 0.55); ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.arc(x, y, R * (1.2 + ph), 0, TAU); ctx.stroke()
  }

  // satellites while a job runs
  if (state === 'working') {
    for (let i = 0; i < 3; i++) {
      const ang = sim.t * 0.9 + (i * TAU) / 3
      ctx.fillStyle = rgba(0.85)
      ctx.beginPath()
      ctx.arc(x + Math.cos(ang) * R * 1.9, y + Math.sin(ang) * R * 1.9 * 0.4, R > 30 ? 3 : 1.8, 0, TAU)
      ctx.fill()
    }
  }
}
