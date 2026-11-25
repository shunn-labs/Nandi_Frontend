// ═══════════════════════════════════════════════════════════
//  messages.js  –  the conversation list and the cards in it
// ═══════════════════════════════════════════════════════════
//
// Pure helpers shared by ChatView (which owns the list), the transcript and
// the stage. Message roles:
//   user      what you sent
//   ai        Nandi's answer, or a `thinking` placeholder waiting for one
//   prompt    a capability needs your answer (approval or small form), or a
//             job's plan waits for approval (a prompt carrying `plan`)
//   activity  a job running somewhere (see ActivityCard.applyActivity)
//   event     something that happened on a device (missed call, …)
//   notification  Nandi telling you something on its own (a reminder, a
//                 scheduled task's result), possibly with files

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
    // A prompt with no expiry of its own gets the 60 s above; a plan card does
    // not count down on a guess (it waits for the brain to close it).
    hasExpiry: Number(f.expires_at) > 0,
    plan: planOf(f.plan),
  }
}

// Where a plan step runs (contract C4). Anything else is shown as "other".
const PLAN_DEVICES = new Set(['pc', 'phone', 'tablet', 'nandi', 'web', 'home', 'other'])
const PLAN_DEVICE_ALIAS = { tab: 'tablet', android: 'phone', ubuntu: 'pc', ubuntu_control: 'pc' }

const textList = (v) => (Array.isArray(v) ? v.map(asText).map(s => s.trim()).filter(Boolean) : [])

/** A whole number of minutes in 1-120, or null. */
const minutes = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : null
}

/**
 * The plan a job proposes, from a prompt frame's `plan` (contract C5), with
 * every field checked: a malformed one becomes null (the card then shows as an
 * ordinary prompt), and malformed parts become empty, so nothing the server
 * sends can break the render.
 */
export function planOf(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const steps = (Array.isArray(p.steps) ? p.steps : [])
    .filter(s => s && typeof s === 'object' && !Array.isArray(s))
    .map((s, i) => {
      const raw = asText(s.device).trim().toLowerCase()
      const device = PLAN_DEVICE_ALIAS[raw] || raw
      return {
        n: Number.isInteger(Number(s.n)) && Number(s.n) > 0 ? Number(s.n) : i + 1,
        device: PLAN_DEVICES.has(device) ? device : 'other',
        action: asText(s.action).trim(),
      }
    })
    .filter(s => s.action)
  return {
    job_id: asText(p.job_id),
    revision: Number.isInteger(Number(p.revision)) && Number(p.revision) > 0 ? Number(p.revision) : 1,
    title: asText(p.title).trim(),
    steps,
    cant_do: textList(p.cant_do),
    needs_from_user: textList(p.needs_from_user),
    assumptions: textList(p.assumptions),
    est_minutes: minutes(p.est_minutes),
    time_limit_min: minutes(p.time_limit_min),
  }
}

export function eventMessage(f) {
  const e = (f.event && typeof f.event === 'object') ? f.event : {}
  const title = asText(e.title || e.kind || 'Something happened')
  const text = asText(e.text)
  return { role: 'event', id: `ev-${asText(e.id) || Date.now()}`, source: asText(f.domain),
           device: asText(e.device), title, text: text ? `${title} — ${text}` : title, ts: Date.now() }
}

export function notificationMessage(n) {
  const item = (n && typeof n === 'object') ? n : {}
  const title = asText(item.title || 'Nandi')
  const body = asText(item.body)
  return {
    role: 'notification', id: `nt-${asText(item.id) || Date.now()}`, notificationId: asText(item.id),
    source: asText(item.source), level: asText(item.level) || 'info', title, body,
    text: body ? `${title} — ${body}` : title,
    fileIds: Array.isArray(item.file_ids) ? item.file_ids.map(asText) : [],
    ts: Date.parse(item.created_at) || Date.now(),
  }
}

/** A job's goal without the "On the phone:" prefix the brain adds to its title. */
export function activityTitle(a) {
  return (a.title || 'Job').replace(/^On the (phone|tablet|pc):\s*/i, '')
}

const OUTCOME = { ok: '✓', error: '✗', stopped: 'Stopped' }

/**
 * One short line for a job in the transcript: its goal and how it ended. The
 * brain's summary also carries step counts, cost and the action list
 * ("SUCCESS: … (4 steps, 15s, …) Actions: … Spent …"); those stay in the
 * Activity tab, where the full card is.
 */
export function activityLine(a) {
  const goal = activityTitle(a).replace(/\.$/, '')
  if (a.state !== 'done') return `${goal} · running`
  const result = (a.summary || '')
    .replace(/^(SUCCESS|FAILED|STOPPED|ERROR)\s*:\s*/i, '')
    .split(/\s\(\d+ steps?\b|\sActions:|\sSpent \$/)[0]
    .trim()
  const mark = OUTCOME[a.status] || ''
  if (!result || /^stopped\.?$/i.test(result)) return `${goal} · ${mark || a.status || 'finished'}`
  return `${goal} · ${mark === 'Stopped' ? 'Stopped: ' : mark ? `${mark} ` : ''}${result}`
}

/** A prompt still waiting for the user (or for the device to take the answer). */
export const isOpenPrompt = (m) => m.role === 'prompt' && ['open', 'sent', 'invalid'].includes(m.status)

const DEVICE_NAME = { tab: 'Tablet', tablet: 'Tablet', pc: 'PC' }
const SOURCE_LABEL = { android: 'Phone', ubuntu_control: 'PC', scheduler: 'Scheduled', system: 'Nandi' }
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

const SPEAK_BLOCK = /<speak>([\s\S]*?)(?:<\/speak>|$)/gi

/**
 * A reply may carry its spoken line as `<speak>…</speak>`. The brain takes it
 * out and sends it as `speech`, but an older or odd reply can still have it in
 * the text: it is never shown, and it is used as the speech when the frame
 * has none. → { display, speech } (speech '' when there was no block).
 */
export function splitSpeak(text) {
  const s = typeof text === 'string' ? text : ''
  if (!/<speak>/i.test(s)) return { display: s, speech: '' }
  const said = []
  const display = s.replace(SPEAK_BLOCK, (_, inner) => { said.push(inner.trim()); return '' })
    .replace(/<\/?speak>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { display, speech: said.filter(Boolean).join(' ') }
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
