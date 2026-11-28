// ═══════════════════════════════════════════════════════════
//  popupWindow.js  –  the desktop pop-up's window
//
//  The desktop shell turns window.open(…, 'nandi-popup') into a frameless,
//  transparent window above every app. This page then draws into it with a
//  React portal, so the pop-up is part of this app: same voice session, same
//  display socket, same cards and handlers. The child document starts empty,
//  so the app's styles and theme (the data-scheme / data-palette attributes
//  on <html>) are copied in and kept in step.
// ═══════════════════════════════════════════════════════════

export const POPUP_NAME = 'nandi-popup'
const COPY = 'data-nandi-copy'

let win = null
let observers = []

/** The pop-up window, opened (hidden: the shell shows it) on first use. Null if it can't be opened. */
export function popupWindow() {
  if (win && !win.closed) return win
  observers.forEach(o => o.disconnect())
  observers = []
  win = window.open('', POPUP_NAME, 'width=760,height=200')
  if (!win) return null
  setup(win)
  return win
}

/** The element the pop-up renders into. */
export function popupRoot() {
  const w = popupWindow()
  return w ? w.document.getElementById('nandi-popup-root') : null
}

function setup(w) {
  const d = w.document
  d.open()
  d.write('<!doctype html><html><head><meta charset="utf-8"><title>Nandi</title></head><body><div id="nandi-popup-root"></div></body></html>')
  d.close()
  const base = d.createElement('base')
  base.href = `${location.origin}/`
  d.head.prepend(base)

  copyStyles(d)
  const headObserver = new MutationObserver(() => copyStyles(d))
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })

  syncRoot(d)
  const rootObserver = new MutationObserver(() => syncRoot(d))
  rootObserver.observe(document.documentElement, { attributes: true })

  observers = [headObserver, rootObserver]
  w.addEventListener('unload', () => { observers.forEach(o => o.disconnect()); observers = [] })
}

/** The app's stylesheets, again in the pop-up (Vite adds and updates <style> tags while developing). */
function copyStyles(d) {
  d.head.querySelectorAll(`[${COPY}]`).forEach(n => n.remove())
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    let copy
    if (node.tagName === 'LINK') {
      copy = d.createElement('link')
      copy.rel = 'stylesheet'
      copy.href = node.href          // absolute
    } else {
      copy = d.createElement('style')
      copy.textContent = node.textContent
    }
    copy.setAttribute(COPY, '')
    d.head.appendChild(copy)
  }
}

/** <html>'s theme attributes, plus the pop-up's own class (transparent page). */
function syncRoot(d) {
  const from = document.documentElement
  const to = d.documentElement
  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name)
  for (const { name, value } of [...from.attributes]) to.setAttribute(name, value)
  to.classList.add('nandi-popup-doc')
}
