import React, { useEffect, useRef } from 'react'

/**
 * The pop-up's top band: Nandi's dotted globe at the left and a voice ribbon
 * (four glowing strings) across the width.
 *
 *   listen   the strings follow your voice (micLevelRef)
 *   speak    they follow Nandi's voice (botLevelRef); the globe ripples
 *   think    a soft shimmer runs along them; the globe swirls
 *   idle     nearly flat
 *
 * It draws with the pop-up window's own animation frames (the canvas lives in
 * that window), so it keeps moving whatever the main window is doing.
 */
const TAU = Math.PI * 2
const POINTS = (() => {
  const n = 150
  const pts = []
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const r = Math.sqrt(1 - y * y)
    const th = i * 2.39996
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r })
  }
  return pts
})()

const STRINGS = [
  { k: 1.6, speed: 1.9, amp: 1.0, alpha: 0.75, width: 2.2 },
  { k: 2.3, speed: -1.4, amp: 0.7, alpha: 0.5, width: 1.6 },
  { k: 1.1, speed: 1.1, amp: 0.55, alpha: 0.38, width: 1.4 },
  { k: 2.9, speed: -2.4, amp: 0.4, alpha: 0.28, width: 1.1 },
]

function accent(doc) {
  const v = doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--acc-rgb').split(',').map(Number)
  return v.length === 3 && v.every(n => !Number.isNaN(n)) ? v : [47, 216, 255]
}

export default function PopupOrb({ mode, micLevelRef, botLevelRef, onActivate }) {
  const canvasRef = useRef(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const canvas = canvasRef.current
    const doc = canvas.ownerDocument
    const win = doc.defaultView
    const ctx = canvas.getContext('2d')
    let raf = 0, w = 0, h = 0, dpr = 1, level = 0, spin = 0, last = 0, ripple = 0
    let rgb = accent(doc)
    const colourTimer = win.setInterval(() => { rgb = accent(doc) }, 1000)

    const fit = () => {
      const r = canvas.getBoundingClientRect()
      dpr = win.devicePixelRatio || 1
      w = Math.max(1, r.width)
      h = Math.max(1, r.height)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ro = new win.ResizeObserver(fit)
    ro.observe(canvas)
    fit()

    const frame = (now) => {
      const t = now / 1000
      const dt = last ? Math.min(0.05, t - last) : 0.016
      last = t
      const m = modeRef.current
      const target = m === 'listen' ? (micLevelRef?.current || 0)
        : m === 'speak' ? (botLevelRef?.current || 0) : 0
      level += (Math.min(1, target) - level) * (1 - Math.exp(-dt * 12))
      spin += dt * (m === 'think' ? 1.8 : m === 'speak' ? 0.5 : 0.25)
      ripple += dt * (2 + level * 6)

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const [r, g, b] = rgb
      const cx = h * 0.62, cy = h / 2, R = h * 0.34

      // The ribbon: from just right of the globe to the far edge.
      const x0 = cx + R * 0.4, x1 = w - 8
      const span = Math.max(1, x1 - x0)
      const base = m === 'idle' ? 1.2 : m === 'think' ? 3 : 2.2
      ctx.lineCap = 'round'
      for (const [i, s] of STRINGS.entries()) {
        const A = (base + level * h * 0.42) * s.amp
        ctx.beginPath()
        for (let x = 0; x <= span; x += 4) {
          const u = x / span
          const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.4     // tapered ends, fuller on the left
          const y = cy + Math.sin(u * TAU * s.k + t * s.speed + i * 1.7) * A * env
          if (x === 0) ctx.moveTo(x0 + x, y)
          else ctx.lineTo(x0 + x, y)
        }
        let alpha = s.alpha * (m === 'idle' ? 0.5 : 1)
        if (m === 'think') {
          const grad = ctx.createLinearGradient(x0, 0, x1, 0)
          const p = (t * 0.45 + i * 0.13) % 1
          grad.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.25})`)
          grad.addColorStop(Math.max(0, p - 0.12), `rgba(${r},${g},${b},${alpha * 0.25})`)
          grad.addColorStop(p, `rgba(${r},${g},${b},${alpha})`)
          grad.addColorStop(Math.min(1, p + 0.12), `rgba(${r},${g},${b},${alpha * 0.25})`)
          grad.addColorStop(1, `rgba(${r},${g},${b},${alpha * 0.25})`)
          ctx.strokeStyle = grad
        } else {
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
        }
        ctx.lineWidth = s.width
        ctx.shadowColor = `rgba(${r},${g},${b},0.55)`
        ctx.shadowBlur = 6 + level * 10
        ctx.stroke()
      }
      ctx.shadowBlur = 0

      // The globe.
      const pulse = 1 + (m === 'speak' ? level * 0.12 : m === 'listen' ? level * 0.05 : 0)
      const cosA = Math.cos(spin), sinA = Math.sin(spin)
      for (const p of POINTS) {
        let x = p.x * cosA - p.z * sinA
        const z = p.x * sinA + p.z * cosA
        let y = p.y
        if (m === 'think') {            // the middle turns faster than the poles
          const tw = spin * 1.4 * (1 - Math.abs(y))
          const c = Math.cos(tw), s = Math.sin(tw)
          const nx = x * c - z * s
          x = nx
        }
        const depth = (z + 1) / 2
        const wave = m === 'speak' ? Math.sin(ripple * 2 - (1 - Math.abs(y)) * 5) * level * 0.08 : 0
        const rr = R * pulse * (1 + wave)
        const px = cx + x * rr, py = cy + y * rr
        ctx.beginPath()
        ctx.arc(px, py, 0.7 + depth * 1.3, 0, TAU)
        ctx.fillStyle = `rgba(${r},${g},${b},${0.18 + depth * 0.75})`
        ctx.fill()
      }
      raf = win.requestAnimationFrame(frame)
    }
    raf = win.requestAnimationFrame(frame)
    return () => {
      win.cancelAnimationFrame(raf)
      win.clearInterval(colourTimer)
      ro.disconnect()
    }
  }, [micLevelRef, botLevelRef])

  return (
    <canvas ref={canvasRef} className="dpop__orb" onClick={onActivate}
      title="Talk to Nandi" aria-label="Nandi" role="img" />
  )
}
