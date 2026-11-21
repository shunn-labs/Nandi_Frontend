// ═══════════════════════════════════════════════════════════
//  themes.js  –  accent themes and light / dark appearance
// ═══════════════════════════════════════════════════════════
//
// Two independent choices:
//   accent      Ion, Ember, Aurora or Graphite      → <html data-palette="…">
//   appearance  system, light or dark               → <html data-scheme="light|dark">
//
// All colours are CSS variables in App.css, one block per (scheme, accent)
// pair. The canvas core reads the same variables (--acc-rgb, --needs-rgb,
// --glow), so adding a theme means one entry here and its CSS blocks.

export const THEMES = {
  ion:      { name: 'Ion',      swatch: '#2fd8ff', note: 'Cyan. The default.' },
  ember:    { name: 'Ember',    swatch: '#ff9d57', note: 'Warm saffron.' },
  aurora:   { name: 'Aurora',   swatch: '#a495ff', note: 'Soft violet.' },
  graphite: { name: 'Graphite', swatch: '#9a9aa3', note: 'Monochrome. Colour only when Nandi needs you.' },
}

export const SCHEMES = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

export const DEFAULT_THEME = 'ion'
export const DEFAULT_SCHEME = 'system'
const THEME_KEY = 'nandi_theme'
const SCHEME_KEY = 'nandi_scheme'

const read = (key, valid, fallback) => {
  try {
    const v = localStorage.getItem(key)
    return valid[v] ? v : fallback
  } catch {
    return fallback
  }
}
const write = (key, value) => {
  try { localStorage.setItem(key, value) } catch { /* private mode: still applied */ }
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

/** The saved accent, or the default. */
export const loadTheme = () => read(THEME_KEY, THEMES, DEFAULT_THEME)

/** The saved appearance choice (system, light or dark), or the default. */
export const loadScheme = () => read(SCHEME_KEY, SCHEMES, DEFAULT_SCHEME)

/** Switches the accent and remembers it. */
export function applyTheme(key) {
  const theme = THEMES[key] ? key : DEFAULT_THEME
  document.documentElement.dataset.palette = theme
  write(THEME_KEY, theme)
  return theme
}

/** Switches the appearance and remembers it. "system" follows the OS. */
export function applyScheme(choice) {
  const scheme = SCHEMES[choice] ? choice : DEFAULT_SCHEME
  document.documentElement.dataset.scheme =
    scheme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : scheme
  write(SCHEME_KEY, scheme)
  return scheme
}

/** Keeps "Match system" in step when the OS switches between light and dark. */
darkQuery.addEventListener('change', () => {
  if (loadScheme() === 'system') applyScheme('system')
})
