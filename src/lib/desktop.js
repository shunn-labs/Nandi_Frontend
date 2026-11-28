// ═══════════════════════════════════════════════════════════
//  desktop.js  –  running inside the Nandi desktop app (Linux)
//
//  shunn-labs/Nandi_Desktop_Assistant is a native shell around this web app.
//  Its preload script puts `window.nandiDesktop` on the page; when it is there
//  the app runs in "desktop mode":
//
//    * voice mode is always on, listening for "Hey Nandi" (pause from the top
//      bar, the tray, Ctrl+H, a shortcut or `nandi --pause`);
//    * when Nandi wakes and this window is not in front, the conversation
//      shows in a pop-up above every app (DesktopPopup draws it into a window
//      the shell keeps on top), which clears itself when she is done;
//    * Google sign-in happens in the system browser (Google refuses embedded
//      browsers): the browser opens /?desktop_login=<port>&state=<nonce>, signs
//      in there and hands the token to the app on 127.0.0.1:<port>;
//    * Settings gets a "Desktop" section (start at login, echo cancellation,
//      quieter music, shortcut, pop-up position).
//
//  In a normal browser `window.nandiDesktop` doesn't exist and nothing here
//  does anything.
// ═══════════════════════════════════════════════════════════

import { isLiveBox } from '../hooks/useStageItems.js'
import { viewerFor } from './fileKinds.js'

const bridge = typeof window !== 'undefined' ? window.nandiDesktop || null : null

export const isDesktop = !!bridge
export const desktop = bridge

/** The main window right now: { visible, focused }. */
export function windowState() {
  if (!bridge) return { visible: !document.hidden, focused: document.hasFocus() }
  return bridge.windowState()
}

/** The app's own window is on screen and focused: Nandi answers here, not in the pop-up. */
export function appInFront() {
  const s = windowState()
  return s.visible && s.focused
}

export function onWindowState(fn) {
  return bridge ? bridge.onWindowState(fn) : () => {}
}

/** Commands from the shell: { command: 'wake' | 'settings' | 'mic-busy' | 'restart-voice', ... } */
export function onDesktopCommand(fn) {
  return bridge ? bridge.onCommand(fn) : () => {}
}

export function getDesktopSettings() {
  return bridge ? bridge.getSettings() : Promise.resolve(null)
}

export function setDesktopSetting(key, value) {
  return bridge ? bridge.setSetting(key, value) : Promise.resolve({ ok: false })
}

// What the app is doing, for the tray icon and for lowering other apps'
// sound. Merged and sent only when something changed.
let reported = {}
export function reportDesktopState(patch) {
  if (!bridge) return
  const next = { ...reported, ...patch }
  if (Object.keys(next).every(k => next[k] === reported[k])) return
  reported = next
  bridge.setState(next)
}

let readySent = false
/** The page is up and can take the shell's commands. */
export function desktopReady() {
  if (!bridge || readySent) return
  readySent = true
  bridge.ready()
}

/**
 * What the pop-up can't show: live views (a camera, a stream, a live mic, this
 * PC's own camera) and web pages. They open the app instead, and the
 * conversation carries on there.
 */
export function needsApp(item) {
  if (item?.type !== 'vision') return false
  const b = item.data || {}
  if (isLiveBox(b)) return true
  return b.type === 'file' && viewerFor(b.file || {}).viewer === 'html'
}

// ── sign-in handoff (in the system browser) ─────────────────

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/

/**
 * This page was opened by the desktop app to sign in: { port, state }, or
 * null. Only a numeric port on 127.0.0.1 is ever used.
 */
export function desktopLoginRequest(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search)
  const port = Number(q.get('desktop_login'))
  const state = q.get('state') || ''
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !STATE_RE.test(state)) return null
  return { port, state }
}

/** Where the browser goes with the token: the desktop app's loopback server. */
export function desktopLoginUrl({ port, state }, token) {
  const u = new URL(`http://127.0.0.1:${port}/done`)
  u.searchParams.set('state', state)
  u.searchParams.set('token', token)
  return u.toString()
}
