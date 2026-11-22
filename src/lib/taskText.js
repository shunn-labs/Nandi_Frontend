// ═══════════════════════════════════════════════════════════
//  taskText.js  –  plain-language descriptions of scheduled tasks
//  ("every weekday at 08:00", "when the camera sees a person").
// ═══════════════════════════════════════════════════════════

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n) => String(n).padStart(2, '0')

function duration(seconds) {
  const s = Number(seconds) || 0
  if (s % 86400 === 0) return s === 86400 ? 'day' : `${s / 86400} days`
  if (s % 3600 === 0) return s === 3600 ? 'hour' : `${s / 3600} hours`
  if (s % 60 === 0) return s === 60 ? 'minute' : `${s / 60} minutes`
  return `${s} seconds`
}

function weekdays(field) {
  if (field === '*') return ''
  if (field === '1-5') return 'every weekday'
  if (field === '0,6' || field === '6,0') return 'every weekend day'
  const names = field.split(',').map(d => DAYS[Number(d) % 7]).filter(Boolean)
  return names.length ? `every ${names.join(', ')}` : ''
}

/** Common cron shapes in words; anything unusual falls back to the expression. */
export function cronText(expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return `cron ${expr}`
  const [min, hour, dom, mon, dow] = parts
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const at = `at ${pad(hour)}:${pad(min)}`
    return `${weekdays(dow) || 'every day'} ${at}`
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every hour at :${pad(min)}`
  const step = /^\*\/(\d+)$/.exec(min)
  if (step && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${step[1]} minutes`
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    return `monthly on day ${dom} at ${pad(hour)}:${pad(min)}`
  }
  return `cron ${expr}`
}

function filterText(filter) {
  const entries = Object.entries(filter || {})
  return entries.length ? ` where ${entries.map(([k, v]) => `${k} contains "${v}"`).join(' and ')}` : ''
}

/** How the task is triggered, in words. */
export function scheduleText(task) {
  const t = task.trigger || {}
  switch (task.trigger_type) {
    case 'once': return 'once'
    case 'interval': return `every ${duration(t.seconds)}`
    case 'cron': return cronText(t.expr)
    case 'event': return `when ${t.type} happens${filterText(t.filter)}`
    default: return task.trigger_type
  }
}

/** A date relative to now: "in 5 min (18:30)", "tomorrow 08:00", "Mon 24 Nov 08:00". */
export function whenText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const mins = Math.round((d - now) / 60000)
  if (mins >= 0 && mins < 60) return mins <= 0 ? `now (${time})` : `in ${mins} min (${time})`
  if (mins < 0 && mins > -60) return `${-mins} min ago (${time})`
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const diff = Math.round((day - today) / 86400000)
  if (diff === 0) return `today ${time}`
  if (diff === 1) return `tomorrow ${time}`
  if (diff === -1) return `yesterday ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/** What the task is waiting for right now. */
export function waitingText(task) {
  if (task.status === 'paused') return 'paused'
  if (task.status !== 'active') return task.status
  if (task.trigger_type === 'event') {
    const cool = Number(task.trigger?.cooldown_seconds) || 0
    return `waiting for ${task.trigger?.type}${cool ? ` (at most once per ${duration(cool)})` : ''}`
  }
  return task.next_run_at ? `next ${whenText(task.next_run_at)}` : 'nothing scheduled'
}

/** What happens when it runs, and where the result goes. */
export function actionText(task) {
  const p = task.payload || {}
  const what = task.kind === 'reminder' ? `Remind: ${p.message || ''}` : `Ask Nandi: ${p.prompt || ''}`
  const channels = (task.delivery?.channels || ['notification'])
    .map(c => (c === 'whatsapp' ? `WhatsApp ${task.delivery?.whatsapp_chat_id || ''}`.trim() : 'this app'))
  return { what, to: channels.join(' + ') }
}
