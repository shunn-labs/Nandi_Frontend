import React, { useState } from 'react'
import './ActivityCard.css'

/**
 * A job running somewhere — a phone task, any capability that reports progress — live, through
 * the brain: its steps as they happen, how it ended, and Stop while it runs. Arrives on the display
 * channel as {action: 'activity'} with the job's full state each time (lib/visionControl.js).
 * Shown in the console's Activity tab; a Nandi job's card (source 'job') is also on the stage
 * while it runs and for a minute after (ChatView).
 *
 * item: { role: 'activity', id, state: 'running'|'done', source, title, lines: [{text, at}],
 *         progress, total, status: 'ok'|'error'|'stopped', summary, can_stop, stopping,
 *         started_at, ended_at }
 */
export default function ActivityCard({ item, onStop }) {
  const running = item.state !== 'done'
  const [open, setOpen] = useState(true)
  const [showPlan, setShowPlan] = useState(false)
  const expanded = running || open
  const lines = item.lines || []
  const steps = lines.filter((l) => !isPlan(l.text))
  const plan = [...lines].reverse().find((l) => isPlan(l.text))
  const label = { ok: 'Done', error: "Couldn't finish", stopped: 'Stopped' }[item.status] || item.status || 'Finished'
  const seconds = item.ended_at && item.started_at ? Math.round((item.ended_at - item.started_at) / 1000) : null

  return (
    <div className={`activity-card activity-card--${running ? 'running' : cardClass(item.status)}`}>
      <div className="activity-card__head">
        <span className="activity-card__title">
          {running && <span className="activity-card__spinner" />}
          {running ? 'Working…' : label}
        </span>
        {running && item.can_stop && onStop && (
          <button className="activity-card__stop" disabled={item.stopping} onClick={() => onStop(item)}>
            {item.stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {!running && steps.length > 0 && (
          <button className="activity-card__toggle" onClick={() => setOpen(!open)}>
            {open ? 'Hide steps' : `Show ${steps.length} step${steps.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
      {item.title && <div className="activity-card__goal">{item.title}</div>}
      {running && item.total > 0 && (
        <progress className="activity-card__progress" value={item.progress || 0} max={item.total} />
      )}

      {plan && expanded && (
        <div className="activity-card__plan">
          <button className="activity-card__toggle" onClick={() => setShowPlan(!showPlan)}>
            {showPlan ? 'Hide plan' : 'Plan'}
          </button>
          {showPlan && <pre>{plan.text.replace(/^(New plan|Plan):\n?/, '')}</pre>}
        </div>
      )}

      {expanded && steps.length > 0 && (
        <ol className="activity-card__steps">
          {steps.map((s, i) => {
            const { status, text } = stepState(s.text, running && i === steps.length - 1)
            return (
              <li key={`${s.at}-${i}`} className={`activity-step activity-step--${status}`}>
                <span className="activity-step__mark">{STEP_GLYPH[status]}</span>
                <span className="activity-step__text">{text}</span>
              </li>
            )
          })}
        </ol>
      )}

      {!running && (
        <div className="activity-card__foot">
          {item.summary && <div className="activity-card__answer">{item.summary}</div>}
          <div className="activity-card__meta">
            {steps.length} step{steps.length === 1 ? '' : 's'}{seconds != null ? ` · ${seconds}s` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

const isPlan = (text) => /^(New plan|Plan):/.test(text || '')
const cardClass = (status) => ({ ok: 'success', error: 'failed', stopped: 'stopped' }[status] || status)

// A line may say how its step went with its first character (a job's card,
// contract C5: "✓ Step 1: …", "✗ Step 2: … — why", "↻ Step 2: … — trying …").
// Without one, the newest line of a running job is what it is doing now and
// the earlier ones are done.
const STEP_MARK = { '✓': 'ok', '✗': 'error', '↻': 'retrying' }
const STEP_GLYPH = { ok: '✓', error: '✗', retrying: '↻', running: '…' }

function stepState(raw, newestWhileRunning) {
  const text = raw || ''
  const marked = STEP_MARK[text.charAt(0)]
  if (marked) return { status: marked, text: text.slice(1).trimStart() }
  return { status: newestWhileRunning ? 'running' : 'ok', text }
}

/**
 * Puts one activity frame into the chat (one card per job id; each frame is the whole state).
 * `doneAt` is when this screen saw the job end (a job card stays on the stage
 * for a while after that): now for a job seen running, or the job's own end
 * time for one that was already over when it arrived (a snapshot on reconnect).
 */
export function applyActivity(messages, frame) {
  const idx = messages.findIndex((m) => m.role === 'activity' && m.id === frame.id)
  if (idx >= 0) {
    const current = messages[idx]
    if (current.state === 'done' && frame.state !== 'done') return messages    // a late update
    const item = { ...current, ...frame, role: 'activity' }
    if (item.state === 'done' && !current.doneAt) item.doneAt = Date.now()
    return messages.map((m, j) => (j === idx ? item : m))
  }
  const item = { ...frame, role: 'activity', ts: Date.now() }
  if (item.state === 'done') item.doneAt = Math.min(Date.now(), Number(frame.ended_at) || Date.now())
  // New card: before a pending "Thinking…" so the reply still replaces the placeholder.
  const last = messages[messages.length - 1]
  return (last && last.role === 'ai' && last.thinking)
    ? [...messages.slice(0, -1), item, last]
    : [...messages, item]
}
