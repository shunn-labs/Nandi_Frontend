// ═══════════════════════════════════════════════════════════
//  conversationApi.js  –  the conversation the brain already keeps
//
//  The brain saves every turn in its database (Postgres): what was said and
//  the screen text of every answer. Windows close by themselves now, so the
//  transcript loads the recent conversation from there at start — an answer
//  that left the screen, or one from an earlier visit, can be opened again.
//  Nothing is stored in the browser and nothing goes to file storage.
//
//    GET /api/conversation/recent?limit=60
//      → { session_id, messages: [{ role: "human"|"assistant", content,
//                                   turn_id, client_id, created_at }] }  oldest first
// ═══════════════════════════════════════════════════════════

import { API_BASE } from './endpoints.js'

const LIMIT = 60

/**
 * The recent conversation as transcript messages, marked `history` (they never
 * open a window or get read out by themselves). [] when the brain has no such
 * endpoint (an older one answers 404) or anything else goes wrong.
 */
export async function loadRecentConversation(limit = LIMIT) {
  let token = ''
  try { token = localStorage.getItem('user_token') || '' } catch { /* site data blocked */ }
  if (!token) return []
  try {
    const res = await fetch(`${API_BASE}/api/conversation/recent?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = await res.json()
    const list = Array.isArray(data?.messages) ? data.messages : []
    return list
      .filter(m => m && (m.role === 'human' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m, i) => {
        const ts = Date.parse(m.created_at) || 0
        const id = `hist-${m.turn_id || ts}-${m.role}-${i}`
        return m.role === 'human'
          ? { role: 'user', id, text: m.content, ts, history: true }
          : { role: 'ai', id, text: m.content, ts, history: true, fromServer: true, errors: [], panel: false }
      })
  } catch {
    return []
  }
}
