// ═══════════════════════════════════════════════════════════
//  tiling.js  –  where each window on the stage goes
//
//  Everything Nandi shows (a photo, a PDF, a live camera, a plan to approve)
//  is a window, and the windows share the stage so that each is as big as it
//  can be: one window takes the whole stage, a second splits it in half, more
//  re-flow into rows.
//
//  The layout is "justified rows": the windows, in the order they appeared,
//  are cut into rows; each row's height is chosen so the row fills the
//  stage's width, and the rows together fill its height. Every way of cutting
//  n ≤ 12 windows into rows is tried (2^(n-1) of them) and the best wins:
//  the most of the stage actually showing something (a picture letterboxed in
//  a window only counts as the picture), windows of similar size (a second
//  window halves the stage rather than squeezing into a corner), and the
//  whole stage used.
//  Too many windows, or a stage too small for them, falls back to a grid that
//  scrolls.
//
//  Pure functions, no DOM: easy to test with node.
// ═══════════════════════════════════════════════════════════

export const HEAD = 40          // a window's title bar

// Shapes are content width / content height (the title bar not counted).
// A media window shows its picture with object-fit: contain, so it may take
// another shape (bars around the picture) when that fills the stage better;
// the score only counts the picture itself, so it does so only when it pays.
const KIND = {
  media:   { pref: 16 / 9, spread: 2.2, minW: 200, minH: 120 },
  doc:     { pref: 0.8, amin: 0.45, amax: 2.6, minW: 260, minH: 170 },
  panel:   { pref: 1.25, amin: 0.7, amax: 2.6, minW: 260, minH: 160 },
  compact: { pref: 3.2, amin: 1.6, amax: 7, minW: 240, minH: 90 },
}

/**
 * item { id, kind: 'media'|'doc'|'panel'|'compact', aspect? } →
 * { id, media, pref, amin, amax, minW, minH }
 */
export function tileSpec(item) {
  const k = KIND[item.kind] || KIND.panel
  if (item.kind === 'media') {
    const pref = item.aspect > 0 && Number.isFinite(item.aspect) ? item.aspect : k.pref
    return { id: item.id, media: true, pref, amin: pref / k.spread, amax: pref * k.spread, minW: k.minW, minH: k.minH }
  }
  return { id: item.id, media: false, pref: k.pref, amin: k.amin, amax: k.amax, minW: k.minW, minH: k.minH }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// How much unequal window sizes cost. Strong enough that a second window takes
// about half the stage (the owner's ask) instead of a strip beside a big one.
const BALANCE = 0.2
const BETAS = [0, 0.5, 1]

/** Binary search for t with f(t) = target, f increasing on [lo, hi]. */
function solve(f, target, lo, hi) {
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Lays one cut of the windows into rows. Returns { rects, score, rows } or
 * null when a window would be smaller than its minimum.
 *
 * beta  how far sizes follow each window's own shape: 1 = fully (a wide video
 *       gets twice a page's width), 0 = not at all (equal shares). Both and
 *       a middle value are tried; the score picks.
 */
function layoutRows(rows, W, H, gap, head, beta) {
  const k = rows.length
  const C = H - gap * (k - 1) - k * head          // height left for content
  if (C <= 0) return null
  const info = rows.map(row => {
    const Wr = W - gap * (row.length - 1)
    const sum = (key) => row.reduce((acc, s) => acc + s[key], 0)
    return { row, Wr, lo: Wr / sum('amax'), hi: Wr / sum('amin'), pref: (Wr / sum('pref')) ** beta }
  })
  const sumLo = info.reduce((a, r) => a + r.lo, 0)
  const sumHi = info.reduce((a, r) => a + r.hi, 0)

  // Each row's content height.
  let heights, squeezed = false
  if (C < sumLo) {
    // Even at their widest the rows are too tall: shrink them all, so the
    // rows end up narrower than the stage (and are centred).
    const s = C / sumLo
    heights = info.map(r => r.lo * s)
    squeezed = true
  } else if (C > sumHi) {
    // Even at their tallest they leave room: the block is centred vertically.
    heights = info.map(r => r.hi)
  } else {
    const total = (t) => info.reduce((a, r) => a + clamp(r.pref * t, r.lo, r.hi), 0)
    const t = solve(total, C, 0, 1e4)
    heights = info.map(r => clamp(r.pref * t, r.lo, r.hi))
  }

  const blockH = heights.reduce((a, c) => a + c + head, 0) + gap * (k - 1)
  let y = Math.max(0, (H - blockH) / 2)
  const rects = []
  let covered = 0, useful = 0
  const areas = []
  for (let j = 0; j < k; j++) {
    const { row, Wr } = info[j]
    const c = heights[j]
    // Each window's shape in this row: as close to its own as the row allows.
    let aspects
    if (squeezed) aspects = row.map(s => s.amax)
    else {
      const width = (r) => row.reduce((a, s) => a + clamp(s.pref ** beta * r, s.amin, s.amax) * c, 0)
      const r = solve(width, Wr, 0, 1e3)
      aspects = row.map(s => clamp(s.pref ** beta * r, s.amin, s.amax))
    }
    const rowW = aspects.reduce((a, x) => a + x * c, 0) + gap * (row.length - 1)
    let x = Math.max(0, (W - rowW) / 2)
    for (let i = 0; i < row.length; i++) {
      const s = row[i]
      const w = aspects[i] * c
      if (w < s.minW - 0.5 || c < s.minH - 0.5) return null
      rects.push({ id: s.id, x, y, w, h: c + head })
      const area = w * (c + head)
      covered += area
      areas.push(area)
      useful += usefulArea(s, w, c, head)
      x += w + gap
    }
    y += c + head + gap
  }
  const n = areas.length
  const mean = covered / n
  const spread = Math.sqrt(areas.reduce((a, v) => a + (v - mean) ** 2, 0) / n) / mean
  const stage = W * H
  return { rects, rows: k, score: 0.65 * (useful / stage) + 0.35 * (covered / stage) - BALANCE * spread }
}

/** How much of a window shows its content. */
function usefulArea(s, w, c, head) {
  if (s.media) {
    // Only the picture counts, not the bars around it.
    const pw = Math.min(w, c * s.pref)
    return pw * (pw / s.pref) + w * head
  }
  // Text and panels reflow, but a very thin or very flat one reads badly.
  const off = Math.abs(Math.log((w / c) / s.pref))
  return w * (c + head) * Math.max(0.5, 1 - 0.2 * off)
}

/** Every way of cutting `specs` (in order) into rows; n ≤ 12 → ≤ 2048. */
function* cuts(specs) {
  const n = specs.length
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const rows = [[specs[0]]]
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) rows.push([specs[i]])
      else rows[rows.length - 1].push(specs[i])
    }
    yield rows
  }
}

/** The fallback: a grid of fixed-width columns that scrolls. */
function grid(specs, W, H, gap, head) {
  const cols = Math.max(1, Math.floor((W + gap) / (340 + gap)))
  const cw = (W - gap * (cols - 1)) / cols
  const rects = []
  let y = 0
  for (let i = 0; i < specs.length; i += cols) {
    const row = specs.slice(i, i + cols)
    const rh = Math.max(...row.map(s => clamp(cw / s.pref + head, s.minH + head, Math.max(s.minH + head, H * 0.7))))
    row.forEach((s, j) => rects.push({ id: s.id, x: j * (cw + gap), y, w: cw, h: rh }))
    y += rh + gap
  }
  return { rects, contentH: Math.max(0, y - gap) }
}

/**
 * tiles  [{ id, pref, amin, amax, minW, minH }] in the order they appeared
 * box    { w, h }  the stage
 * → { rects: Map<id, {x, y, w, h}>, contentH, overflow }
 */
export function layoutTiles(tiles, box, { gap = 10, pad = 0, head = HEAD, maxExact = 12 } = {}) {
  const rects = new Map()
  const W = Math.max(0, (box?.w || 0) - 2 * pad)
  const H = Math.max(0, (box?.h || 0) - 2 * pad)
  if (!tiles.length || W <= 0 || H <= 0) return { rects, contentH: 0, overflow: false }
  const place = (list) => { for (const r of list) rects.set(r.id, { x: r.x + pad, y: r.y + pad, w: r.w, h: r.h }) }

  // One window: the whole stage, whatever it holds.
  if (tiles.length === 1) {
    place([{ id: tiles[0].id, x: 0, y: 0, w: W, h: H }])
    return { rects, contentH: H, overflow: false }
  }

  let best = null
  if (tiles.length <= maxExact) {
    for (const rows of cuts(tiles)) {
      for (const beta of BETAS) {
        const res = layoutRows(rows, W, H, gap, head, beta)
        if (!res) continue
        if (!best || res.score > best.score + 1e-9
            || (Math.abs(res.score - best.score) <= 1e-9 && res.rows < best.rows)) best = res
      }
    }
  }
  if (best) {
    place(best.rects)
    return { rects, contentH: H, overflow: false }
  }
  const g = grid(tiles, W, H, gap, head)
  place(g.rects)
  return { rects, contentH: g.contentH + 2 * pad, overflow: g.contentH > H }
}
