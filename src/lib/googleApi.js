// ═══════════════════════════════════════════════════════════
//  googleApi.js  –  connect the user's Google account (Gmail, Drive)
//
//  The brain runs the whole OAuth exchange and keeps the tokens
//  (Brain: api/google.py, manager/google_accounts.py). Here we only
//  ask for the consent URL, open it in a popup, and read the status.
// ═══════════════════════════════════════════════════════════

import { API_BASE } from './endpoints.js'

async function request(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('user_token')
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data?.message || data?.detail || res.statusText
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`)
  }
  return data
}

export const googleStatus = () => request('/api/google/status')
export const googleDisconnect = () => request('/api/google', { method: 'DELETE' })

/**
 * Open Google's consent screen in a popup and resolve when it closes.
 * The popup is opened synchronously, inside the click, so browsers don't
 * block it; its address is filled in once the brain returns the URL.
 * Resolves with the callback page's message ({ok, email, services} or {ok:false, error}),
 * or null if the window was closed without finishing.
 */
export async function googleConnect(services) {
  const popup = window.open('', 'nandi-google', 'width=520,height=680')
  let url
  try {
    ({ url } = await request('/api/google/connect', { method: 'POST', body: { services } }))
  } catch (e) {
    popup?.close()
    throw e
  }
  if (!popup) {             // blocked anyway: fall back to a full-page visit
    window.location.href = url
    return null
  }
  popup.location.href = url
  return new Promise((resolve) => {
    let result = null
    const onMessage = (e) => {
      if (e.data?.type === 'nandi-google') result = e.data
    }
    window.addEventListener('message', onMessage)
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer)
        window.removeEventListener('message', onMessage)
        resolve(result)
      }
    }, 400)
  })
}
