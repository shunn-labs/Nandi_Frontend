// ═══════════════════════════════════════════════════════════
//  audioApi.js  –  what every call to the Nandi Audio Server shares
//
//  The audio server verifies the same brain JWT the chat socket uses, so a
//  request is just `Authorization: Bearer <user_token>`. Failures are turned
//  into one sentence the user can act on; the server's own `detail` goes to
//  the console, where it helps whoever is debugging.
// ═══════════════════════════════════════════════════════════

import { AUDIO_BASE } from './endpoints.js'

export function authHeaders(extra = {}) {
  const token = localStorage.getItem('user_token')
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

/** host[:port] of the audio server in use, for messages. */
export function audioHost() {
  try { return new URL(AUDIO_BASE).host } catch { return AUDIO_BASE }
}

/** FastAPI's `{"detail": …}` (or the plain body), or '' if there is none. */
export async function responseDetail(res) {
  try {
    const body = await res.clone().text()
    try {
      const json = JSON.parse(body)
      if (typeof json?.detail === 'string') return json.detail
      if (typeof json?.error?.message === 'string') return json.error.message
    } catch { /* not JSON */ }
    return body.slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * An Error for a failed audio-server response. `messages` maps a status to
 * the sentence to show; `fallback` is used for any other status.
 * The Error carries `status`, the server's `detail`, and `userMessage`.
 */
export async function audioResponseError(res, messages, fallback) {
  const detail = await responseDetail(res)
  const userMessage =
    messages[res.status] ||
    (res.status === 401 ? 'Your session has expired — sign in again.' : '') ||
    fallback
  console.warn(`[audio] ${res.url} → ${res.status}${detail ? `: ${detail}` : ''}`)
  return Object.assign(new Error(userMessage), { status: res.status, detail, userMessage })
}

/** An Error for a request that never got an answer (offline, DNS, CORS, server down). */
export function audioNetworkError(cause, what = 'the audio server') {
  const userMessage = `Can't reach ${what} (${audioHost()}).`
  console.warn(`[audio] ${userMessage}`, cause)
  return Object.assign(new Error(userMessage), { status: 0, cause, userMessage })
}
