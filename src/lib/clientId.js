// ═══════════════════════════════════════════════════════════
//  clientId.js  –  one client_id for this browser, used everywhere
//
//  The chat socket used to send a hardcoded 'nandi_web' while the vision
//  control socket registered as `web_react_<device>`, and api/chat.py's own
//  protocol docs named a third set entirely ('react_web', 'android_app',
//  'ubuntu_pc'). Three names for one browser.
//
//  This is not cosmetic. client_id is passed to the planner as CLIENT and is
//  what it reasons over when deciding which device to act on — so the planner
//  was being told a device name that appeared nowhere in its own vocabulary,
//  and the vision agent's client routing could not match the chat client.
// ═══════════════════════════════════════════════════════════

const DEVICE_COOKIE = 'nandi_device_id'

/** The device name the user chose at first launch, or 'unknown'. */
export function getDeviceName() {
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`)
  )
  return match ? decodeURIComponent(match[1]) : 'unknown'
}

/**
 * This browser's client_id: `web_react_<device>`.
 *
 * Both the chat socket and the vision-control socket send exactly this, so the
 * brain, the planner and the vision agent all refer to the same device by the
 * same name.
 */
export function getClientId() {
  return `web_react_${getDeviceName()}`
}
