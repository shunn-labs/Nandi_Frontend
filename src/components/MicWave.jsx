import React, { useEffect, useRef } from 'react'

const COL_PX = 5          // one column of dots every 5px
const DOT_PX = 4          // vertical distance between dots in a column
const SAMPLE_MS = 45      // a new column slides in this often
const DOT_R = 1.25

function accent() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb').split(',').map(Number)
  return v.length === 3 && v.every(n => !Number.isNaN(n)) ? v : [47, 216, 255]
}

/**
 * The user's voice as a row of dots sliding left — a flat dotted line while
 * they are quiet, rising into waves as they speak. It lives in the chat bar
 * (and the voice-mode panel) so the core can stay calm: the core only moves
 * for Nandi.
 *
 * levelRef  ref holding the mic level, 0..1 (written many times a second;
 *           a ref so nothing re-renders)
 * active    draw and slide; when false the line rests flat and the loop stops
 * pulseRef  optional element that gets `--lvl` (0..1) each frame, e.g. the
 *           mic button, so its ring can breathe with the voice
 */
export default function MicWave({ levelRef, active = true, pulseRef, className = '' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let w = 0, h = 0, dpr = 1, raf = 0, needsResize = true
    let cols = []              // newest last
    let lastSample = 0, smooth = 0
    let [r, g, b] = accent()

    const ro = new ResizeObserver(() => { needsResize = true })
    ro.observe(canvas)

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = rect.width; h = rect.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      needsResize = false
      const n = Math.max(1, Math.floor(w / COL_PX))
      cols = cols.slice(-n)
      while (cols.length < n) cols.unshift(0)
      ;[r, g, b] = accent()
    }

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const mid = h / 2
      const maxDots = Math.max(1, Math.floor((h / 2 - 2) / DOT_PX))
      const n = cols.length
      for (let i = 0; i < n; i++) {
        const x = w - (n - i) * COL_PX + COL_PX / 2
        // The oldest columns fade out at the left edge.
        const fade = Math.min(1, (i + 1) / (n * 0.25))
        const dots = Math.round(Math.pow(cols[i], 0.6) * maxDots)
        ctx.fillStyle = `rgba(${r},${g},${b},${(active ? 0.85 : 0.4) * fade})`
        ctx.beginPath()
        ctx.arc(x, mid, DOT_R, 0, Math.PI * 2)
        for (let d = 1; d <= dots; d++) {
          ctx.moveTo(x + DOT_R, mid - d * DOT_PX)
          ctx.arc(x, mid - d * DOT_PX, DOT_R, 0, Math.PI * 2)
          ctx.moveTo(x + DOT_R, mid + d * DOT_PX)
          ctx.arc(x, mid + d * DOT_PX, DOT_R, 0, Math.PI * 2)
        }
        ctx.fill()
      }
    }

    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      if (needsResize) resize()
      if (!w || !h) return
      const level = active ? Math.min(1, Math.max(0, levelRef?.current || 0)) : 0
      smooth += (level - smooth) * 0.35
      if (pulseRef?.current) pulseRef.current.style.setProperty('--lvl', smooth.toFixed(3))
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now
        cols.push(smooth)
        if (cols.length > Math.max(1, Math.floor(w / COL_PX))) cols.shift()
      }
      draw()
      // Resting: one last flat frame, then no loop until it is active again.
      if (!active && smooth < 0.002 && cols.every(c => c < 0.002)) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (pulseRef?.current) pulseRef.current.style.removeProperty('--lvl')
    }
  }, [active, levelRef, pulseRef])

  return <canvas ref={canvasRef} className={`mic-wave ${className}`} aria-hidden="true" />
}
