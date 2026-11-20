// ═══════════════════════════════════════════════════════════
//  messages.js  –  the conversation list and the cards in it
// ═══════════════════════════════════════════════════════════
//
// Pure helpers shared by ChatView (which owns the list), the transcript and
// the stage. Message roles:
//   user      what you sent
//   ai        Nandi's answer, or a `thinking` placeholder waiting for one
//   prompt    a capability needs your answer (approval or small form)
//   activity  a job running somewhere (see ActivityCard.applyActivity)
//   event     something that happened on a device (missed call, …)

// Server-supplied fields are coerced to strings before they reach JSX: an
// object there would throw during render and blank the whole screen.
export const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

export const toProblem = (e) => (e && typeof e === 'object'
  ? { stage: asText(e.stage), source: asText(e.source), message: asText(e.message), hint: asText(e.hint) }
  : { stage: '', source: '', message: asText(e), hint: '' })

/** Index of the placeholder still waiting on `requestId`, or -1. */
export const findPending = (list, requestId) =>
  list.findIndex(m => m.thinking && m.requestId === requestId)

/**
 * Adds a card before a pending "Thinking…" placeholder, so the reply still
 * replaces the placeholder and lands under the card.
 */
export function insertCard(list, card) {
  const last = list[list.length - 1]
  return (last && last.role === 'ai' && last.thinking)
    ? [...list.slice(0, -1), card, last]
    : [...list, card]
}

export function promptMessage(f) {
  return {
    role: 'prompt', id: asText(f.id), kind: f.kind === 'form' ? 'form' : 'confirm',
    source: asText(f.source), title: asText(f.title), message: asText(f.message), detail: asText(f.detail),
    device: asText(f.device), fields: Array.isArray(f.fields) ? f.fields : [],
    suggestions: Array.isArray(f.suggestions) ? f.suggestions.map(asText) : [],
    expiresAt: Number(f.expires_at) || Date.now() + 60000, status: 'open', ts: Date.now(),
  }
}

export function eventMessage(f) {
  const e = (f.event && typeof f.event === 'object') ? f.event : {}
  const title = asText(e.title || e.kind || 'Something happened')
  const text = asText(e.text)
  return { role: 'event', id: `ev-${asText(e.id) || Date.now()}`, source: asText(f.domain),
           device: asText(e.device), title, text: text ? `${title} — ${text}` : title, ts: Date.now() }
}

/** A prompt still waiting for the user (or for the device to take the answer). */
export const isOpenPrompt = (m) => m.role === 'prompt' && ['open', 'sent', 'invalid'].includes(m.status)

const DEVICE_NAME = { tab: 'Tablet', tablet: 'Tablet', pc: 'PC' }
const SOURCE_LABEL = { android: 'Phone', ubuntu_control: 'PC' }
const capitalise = (s) => s.replace(/^./, c => c.toUpperCase())

/** Who a card is from, for its label: "Phone", "PC", "Tablet", … */
export function cardLabel(m) {
  if (m.device) return DEVICE_NAME[m.device] || capitalise(m.device)
  return SOURCE_LABEL[m.source] || (m.source ? capitalise(m.source) : 'Nandi')
}

/**
 * Whether an answer is too long or too structured for subtitles: it then opens
 * as a panel on the stage, and the subtitles show only its first sentence.
 */
export function needsPanel(text, errors) {
  if (errors?.length) return true
  if (text.length > 260) return true
  return /```|^\s*([-*+]|\d+\.)\s|^\s*\|.*\||^#{1,4}\s/m.test(text)
}

/** The first sentence of a reply, without markdown symbols, for subtitles. */
export function firstSentence(text, max = 140) {
  const plain = text
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')   // list markers
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const end = plain.search(/[.!?](\s|$)/)
  const sentence = end > 0 ? plain.slice(0, end + 1) : plain
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}
