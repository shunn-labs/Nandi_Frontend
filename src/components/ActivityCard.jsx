import React, { useState } from 'react'

/**
 * What a device's agent is doing, live: the task, its plan, each step as it happens (✓ / ✗), and
 * how it ended. Fed by Brain's {type: 'device_activity'} frames (see applyActivity).
 */
export default function ActivityCard({ item }) {
  const running = item.state !== 'done'
  const [open, setOpen] = useState(true)
  const [showPlan, setShowPlan] = useState(false)
  const expanded = running || open
  const device = item.device === 'tab' ? 'Tablet' : (item.device || 'phone').replace(/^./, (c) => c.toUpperCase())
  const title = running
    ? `${device} · working…`
    : `${device} · ${{ success: 'done', failed: "couldn't finish", stopped: 'stopped' }[item.status] || item.status}`

  return (
    <div className={`activity-card activity-card--${running ? 'running' : item.status}`}>
      <div className="activity-card__head">
        <span className="activity-card__title">
          {running && <span className="activity-card__spinner" />}
          {title}
        </span>
        {!running && (
          <button className="activity-card__toggle" onClick={() => setOpen(!open)}>
            {open ? 'Hide steps' : `Show ${item.steps.length} step${item.steps.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
      {item.goal && <div className="activity-card__goal">{item.goal}</div>}

      {item.plan && expanded && (
        <div className="activity-card__plan">
          <button className="activity-card__toggle" onClick={() => setShowPlan(!showPlan)}>
            {showPlan ? 'Hide plan' : 'Plan'}
          </button>
          {showPlan && <pre>{item.plan}</pre>}
        </div>
      )}

      {expanded && item.steps.length > 0 && (
        <ol className="activity-card__steps">
          {item.steps.map((s) => (
            <li key={s.n} className={`activity-step activity-step--${s.status}`}>
              <span className="activity-step__mark">{s.status === 'running' ? '…' : s.status === 'ok' ? '✓' : '✗'}</span>
              <span className="activity-step__text">{s.text}</span>
              {s.note && <span className="activity-step__note">{s.note}</span>}
            </li>
          ))}
        </ol>
      )}

      {!running && (
        <div className="activity-card__foot">
          {item.answer && <div className="activity-card__answer">{item.answer}</div>}
          <div className="activity-card__meta">
            {item.stepCount} steps · {item.seconds}s{item.cost ? ` · $${item.cost.toFixed(4)}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

/** Folds one device_activity frame into the chat's messages (one card per task). */
export function applyActivity(messages, data) {
  const idx = messages.findIndex((m) => m.role === 'activity' && m.taskId === data.task_id)
  let item = idx >= 0 ? messages[idx] : {
    role: 'activity', taskId: data.task_id, device: data.device, goal: '', plan: '',
    steps: [], state: 'running', ts: Date.now(),
  }
  item = { ...item, steps: [...item.steps] }

  switch (data.state) {
    case 'started':
      item.goal = data.goal || item.goal
      break
    case 'plan':
      item.plan = data.text || ''
      break
    case 'step':
      item.steps.push({ n: data.step, text: data.text || 'Working', status: 'running', note: '' })
      break
    case 'step_done': {
      const i = item.steps.findIndex((s) => s.n === data.step)
      if (i >= 0) item.steps[i] = { ...item.steps[i], status: data.ok ? 'ok' : 'error', note: data.note || '' }
      break
    }
    case 'done':
      item = { ...item, state: 'done', status: data.status, answer: data.answer, stepCount: data.steps,
               seconds: data.seconds, cost: data.cost_usd }
      item.steps = item.steps.map((s) => (s.status === 'running' ? { ...s, status: 'ok' } : s))
      break
    default:
      return messages
  }

  if (idx >= 0) return messages.map((m, j) => (j === idx ? item : m))
  // New card: before a pending "Thinking…" so the reply still replaces the placeholder.
  const last = messages[messages.length - 1]
  return (last && last.role === 'ai' && last.thinking)
    ? [...messages.slice(0, -1), item, last]
    : [...messages, item]
}
