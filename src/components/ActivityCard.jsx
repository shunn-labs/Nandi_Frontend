import React, { useState } from 'react'

/**
 * A job running somewhere — a phone task, any capability that reports progress — live, through
 * the brain: its steps as they happen, how it ended, and Stop while it runs. Arrives on the display
 * channel as {action: 'activity'} with the job's full state each time (lib/visionControl.js).
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
            const failed = s.text.startsWith('✗')
            const current = running && i === steps.length - 1 && !failed
            const status = failed ? 'error' : current ? 'running' : 'ok'
            return (
              <li key={`${s.at}-${i}`} className={`activity-step activity-step--${status}`}>
                <span className="activity-step__mark">{status === 'running' ? '…' : status === 'ok' ? '✓' : '✗'}</span>
                <span className="activity-step__text">{failed ? s.text.replace(/^✗\s*/, '') : s.text}</span>
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

/** Puts one activity frame into the chat (one card per job id; each frame is the whole state). */
export function applyActivity(messages, frame) {
  const idx = messages.findIndex((m) => m.role === 'activity' && m.id === frame.id)
  if (idx >= 0) {
    const current = messages[idx]
    if (current.state === 'done' && frame.state !== 'done') return messages    // a late update
    const item = { ...current, ...frame, role: 'activity' }
    return messages.map((m, j) => (j === idx ? item : m))
  }
  const item = { ...frame, role: 'activity', ts: Date.now() }
  // New card: before a pending "Thinking…" so the reply still replaces the placeholder.
  const last = messages[messages.length - 1]
  return (last && last.role === 'ai' && last.thinking)
    ? [...messages.slice(0, -1), item, last]
    : [...messages, item]
}
