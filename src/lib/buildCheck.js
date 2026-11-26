// ═══════════════════════════════════════════════════════════
//  buildCheck.js  –  notice when this page runs an older build than the one deployed
//
//  A phone or tablet keeps a tab open for days, and the page keeps running the
//  JavaScript it loaded then. Whatever was released since simply does not exist
//  on it — on 2026-11-25 a phone kept sending JPEG frames because its page
//  predated the media hub. The deployed index.html names its bundle
//  (assets/index-<hash>.js); when that differs from the bundle this page runs,
//  a newer build is out and the page should be reloaded.
//
//  Checked when the page becomes visible again (the phone case) and every few
//  minutes while it is visible. Nothing happens on the dev server (no bundle).
// ═══════════════════════════════════════════════════════════

const CHECK_EVERY_MS = 5 * 60 * 1000
const BUNDLE_RE = /src="([^"]*\/assets\/index-[^"]+\.js)"/

function runningBundle() {
  const el = document.querySelector('script[type="module"][src*="/assets/index-"]')
  return el ? new URL(el.getAttribute('src'), location.href).pathname : ''
}

/** The bundle the server would hand out now ('' when it can't be told). */
async function deployedBundle() {
  try {
    const base = import.meta.env.BASE_URL || '/'
    const r = await fetch(`${base}?build-check=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return ''
    const m = BUNDLE_RE.exec(await r.text())
    return m ? new URL(m[1], location.href).pathname : ''
  } catch {
    return ''                         // offline: try again later
  }
}

/**
 * Calls onNewBuild() once when a newer build is deployed. Returns a stop function.
 */
export function watchForNewBuild(onNewBuild) {
  const mine = runningBundle()
  if (!mine) return () => {}
  let stopped = false
  let told = false

  async function check() {
    if (stopped || told || document.visibilityState === 'hidden') return
    const latest = await deployedBundle()
    if (!stopped && !told && latest && latest !== mine) {
      told = true
      onNewBuild()
    }
  }

  const onVisible = () => { if (document.visibilityState === 'visible') check() }
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(check, CHECK_EVERY_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
