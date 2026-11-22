// ═══════════════════════════════════════════════════════════
//  filesApi.js  –  Nandi's file store and notifications (brain REST API)
//
//  Every file that reached Nandi — uploads, camera frames, phone/PC
//  screenshots — lives in the brain's central file store
//  (Brain: manager/file_store.py, api/files.py). This module lists them,
//  downloads them, and asks the brain to show or send one somewhere.
// ═══════════════════════════════════════════════════════════

import { API_BASE } from './endpoints.js'

function authHeaders(extra = {}) {
  const token = localStorage.getItem('user_token')
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    // The brain's own refusals carry `message` (a delivery that failed is a 422
    // with the reason); FastAPI's validation errors carry a `detail` list.
    const detail = data?.message || data?.detail || res.statusText
    const text = Array.isArray(detail) ? detail.map(d => d?.msg).filter(Boolean).join('; ') : detail
    throw new Error(typeof text === 'string' && text ? text : `Request failed (${res.status})`)
  }
  return data
}

/** A link the brain handed out (/f/<token>) made absolute for this backend. */
export function absoluteUrl(url) {
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : `${API_BASE}${url}`
}

/** ?q=&kind=&source=&limit= → { files, next_before } */
export function listFiles({ q = '', kind = '', source = '', limit = 50, before = '' } = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (kind) params.set('kind', kind)
  if (source) params.set('source', source)
  if (before) params.set('before', before)
  params.set('limit', String(limit))
  return request(`/api/files?${params}`)
}

export const updateFile = (id, patch) => request(`/api/files/${id}`, { method: 'PATCH', body: patch })
export const deleteFile = (id) => request(`/api/files/${id}`, { method: 'DELETE' })

/** A signed download URL, usable without a login, for a limited time. */
export async function fileLink(id, ttlSeconds) {
  const data = await request(`/api/files/${id}/link`, {
    method: 'POST', body: ttlSeconds ? { ttl_seconds: ttlSeconds } : {},
  })
  return absoluteUrl(data.url)
}

/**
 * Ask the brain to send a file somewhere:
 *   { type: 'client', client_id }   a screen of yours (or { type: 'client', all: true })
 *   { type: 'whatsapp', chat_id, caption }        chat_id '' = your own number
 *   { type: 'email', email, subject, caption }    email '' = your own address
 *   { type: 'pc' }                                saved on the PC
 *   { type: 'android', device: 'phone' | 'tab' }  downloaded on the phone or tablet
 * Resolves to the brain's result ({ ok, message, ... }); a refusal rejects
 * with its reason.
 */
export const deliverFile = (id, target) => request(`/api/files/${id}/deliver`, { method: 'POST', body: { target } })

/** Save a file to this device (authenticated fetch → browser download). */
export async function downloadFile(id, filename) {
  const res = await fetch(`${API_BASE}/api/files/${id}/content?download=1`, { headers: authHeaders() })
  if (!res.ok) throw new Error(res.status === 404 ? 'File not found' : `Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** This user's devices with a Nandi screen open: [{ client_id, device_name, display_connected, ... }] */
export async function listClients() {
  const data = await request('/api/vision/clients')
  return Array.isArray(data?.clients) ? data.clients : []
}

export const markNotificationsRead = (ids) =>
  request('/api/notifications/read', { method: 'POST', body: ids ? { ids } : {} })

export function humanSize(n) {
  const size = Number(n) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

export const SOURCE_LABEL = {
  chat_upload: 'upload', vision: 'camera', android: 'phone', ubuntu: 'PC', mcp: 'tool',
  audio: 'recording', job: 'job', device: 'device',
}

// ── Scheduled tasks (Brain: manager/scheduler.py, api/tasks.py) ──────────

/** → [{ task_id, title, kind, trigger_type, trigger, status, next_run_at, ... }] */
export async function listTasks({ includeFinished = false } = {}) {
  const data = await request(`/api/tasks?include_finished=${includeFinished ? 1 : 0}`)
  return Array.isArray(data?.tasks) ? data.tasks : []
}

/** action: pause | resume | cancel | run */
export const taskAction = (id, action) => request(`/api/tasks/${id}/${action}`, { method: 'POST' })

export async function taskRuns(id, limit = 10) {
  const data = await request(`/api/tasks/${id}/runs?limit=${limit}`)
  return Array.isArray(data?.runs) ? data.runs : []
}
