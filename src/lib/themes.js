// ═══════════════════════════════════════════════════════════
//  themes.js  –  colour themes for the whole app
// ═══════════════════════════════════════════════════════════
//
// A theme is a set of CSS variables (App.css, `:root[data-palette=…]`) plus the
// colours the canvas core draws with, which CSS cannot reach. Adding a theme
// means one entry here and one block in App.css.

export const THEMES = {
  ion: {
    name: 'Ion',
    swatch: '#2fd8ff',
    note: 'Cyan on navy. The default.',
    core: [47, 216, 255],
    needs: [255, 181, 71],
  },
  ember: {
    name: 'Ember',
    swatch: '#ff9d57',
    note: 'Warm saffron on charcoal.',
    core: [255, 157, 87],
    needs: [127, 212, 255],
  },
  aurora: {
    name: 'Aurora',
    swatch: '#a495ff',
    note: 'Soft violet on ink blue.',
    core: [164, 149, 255],
    needs: [255, 192, 103],
  },
  graphite: {
    name: 'Graphite',
    swatch: '#eef2f7',
    note: 'Monochrome. Colour only when Nandi needs you.',
    core: [228, 234, 242],
    needs: [255, 181, 71],
  },
}

export const DEFAULT_THEME = 'ion'
const STORAGE_KEY = 'nandi_theme'

/** The saved theme, or the default when none (or an unknown one) is saved. */
export function loadTheme() {
  try {
    const key = localStorage.getItem(STORAGE_KEY)
    return THEMES[key] ? key : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Switches the page to `key` and remembers it for the next visit. */
export function applyTheme(key) {
  const theme = THEMES[key] ? key : DEFAULT_THEME
  document.documentElement.dataset.palette = theme
  try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* private mode: still applied */ }
  return theme
}
