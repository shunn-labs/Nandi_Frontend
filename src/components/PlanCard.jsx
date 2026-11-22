import React, { useState } from 'react'
import { outcomeText, usePromptClock } from './PromptCard.jsx'
import './PlanCard.css'

const DEVICE_LABEL = { pc: 'PC', phone: 'Phone', tablet: 'Tablet', nandi: 'Nandi', web: 'Web', home: 'Home', other: 'Other' }
const LIMIT_CHOICES = [5, 15, 30, 60]
const DEFAULT_LIMIT = 15

/**
 * A job's plan, waiting for your OK. Nandi scanned what is connected, planned
 * the job in one go and sends the plan as an ordinary prompt frame that also
 * carries `plan` (contract C5), so an older screen still gets a plain form.
 *
 *   Approve  starts the job with the chosen time limit
 *   Cancel   drops it
 *   Change   is a normal chat message ("Change the plan: …"); the brain
 *            answers with a new plan card and closes this one
 *
 * The same can be said by voice or typed in chat; the brain then closes this
 * card on every screen.
 *
 * msg: a prompt message (lib/messages.js promptMessage) whose `plan` is set:
 *      { job_id, revision, title, steps: [{n, device, action}], cant_do,
 *        needs_from_user, assumptions, est_minutes, time_limit_min }
 * onAnswer(id, 'accept', {decision: 'approve', time_limit_min} | {decision: 'cancel'})
 * onChange(text)
 */
export default function PlanCard({ msg, onAnswer, onChange }) {
  const plan = msg.plan
  // No expiry from the server: no countdown, the card waits for the brain.
  const { left, expired, live } = usePromptClock(msg, msg.hasExpiry)
  const preset = plan.time_limit_min || fieldDefault(msg.fields, 'time_limit_min') || DEFAULT_LIMIT
  const [limit, setLimit] = useState(preset)
  const [choice, setChoice] = useState('')         // 'approve' | 'cancel', once tapped here
  const [draft, setDraft] = useState('')
  const [asked, setAsked] = useState('')           // the change last sent from this card

  // The plan's own limit is always one of the chips, even an unusual one.
  const limits = [...new Set([...LIMIT_CHOICES, preset])].sort((a, b) => a - b)

  const decide = (decision) => {
    if (!live) return
    setChoice(decision)
    onAnswer(msg.id, 'accept', decision === 'approve' ? { decision, time_limit_min: limit } : { decision })
  }
  const sendChange = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!live || !text) return
    onChange(text)
    setAsked(text)
    setDraft('')
  }

  const about = plan.est_minutes ? `about ${plan.est_minutes} min` : msg.detail

  return (
    <div className={`prompt-card plan-card ${live ? '' : 'prompt-card--done'}`}>
      <div className="prompt-card__head">
        <span>{plan.revision > 1 ? `Changed plan · revision ${plan.revision}` : 'Proposed plan'}</span>
        {live && left != null && <span className="prompt-card__timer">{clock(left)}</span>}
      </div>
      <div className="plan-card__title">{plan.title || msg.title || 'Plan'}</div>

      {plan.steps.length > 0 ? (
        <ol className="plan-card__steps">
          {plan.steps.map((s, i) => (
            <li key={`${s.n}-${i}`} className="plan-card__step">
              <span className="plan-card__n">{s.n}</span>
              <span className={`plan-card__device plan-card__device--${s.device}`}>{DEVICE_LABEL[s.device]}</span>
              <span className="plan-card__action">{s.action}</span>
            </li>
          ))}
        </ol>
      ) : (
        msg.message && <div className="prompt-card__what">{msg.message}</div>
      )}

      {plan.cant_do.length > 0 && (
        <div className="plan-card__note plan-card__note--cant">
          <div className="plan-card__note-head">Can't do</div>
          <ul>{plan.cant_do.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {plan.needs_from_user.length > 0 && (
        <div className="plan-card__note plan-card__note--needs">
          <div className="plan-card__note-head">Needs you</div>
          <ul>{plan.needs_from_user.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {plan.assumptions.length > 0 && (
        <div className="plan-card__assume">Assuming {plan.assumptions.join(' · ')}</div>
      )}
      {about && <div className="plan-card__about">{about}</div>}
      {msg.status === 'invalid' && <div className="prompt-card__why">That answer doesn't fit — try again.</div>}

      {live && (
        <>
          <div className="plan-card__limit">
            <span className="plan-card__limit-label" id={`${msg.id}-limit`}>Time limit</span>
            <div className="plan-card__chips" role="radiogroup" aria-labelledby={`${msg.id}-limit`}>
              {limits.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={m === limit}
                  className={`plan-card__chip${m === limit ? ' plan-card__chip--on' : ''}`}
                  onClick={() => setLimit(m)}>
                  {m} min
                </button>
              ))}
            </div>
          </div>
          <div className="prompt-card__actions">
            <button className="prompt-card__btn prompt-card__btn--deny" onClick={() => decide('cancel')}>Cancel</button>
            <button className="prompt-card__btn plan-card__approve" onClick={() => decide('approve')}>Approve</button>
          </div>
          <form className="prompt-card__reply plan-card__change" onSubmit={sendChange}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500}
              placeholder="Change something…" aria-label="Change the plan" />
            <button className="prompt-card__btn" type="submit" disabled={!draft.trim()}>Send</button>
          </form>
          {asked && <div className="plan-card__asked">Asked for a change: “{asked}”. A new plan will replace this one.</div>}
        </>
      )}

      {!live && <div className="prompt-card__outcome">{planOutcome(msg.status, choice, expired)}</div>}
    </div>
  )
}

/** A field's default as a time limit in minutes (1-120), or null. */
function fieldDefault(fields, name) {
  const f = (fields || []).find((x) => x && x.name === name)
  const n = Math.round(Number(f?.default))
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : null
}

/** 42s, 12:05, or 1:00:00: a plan may wait an hour or more for its OK. */
function clock(seconds) {
  if (seconds < 60) return `${seconds}s`
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`
}

function planOutcome(status, choice, expired) {
  if (expired) return 'No answer in time: the job was not started.'
  switch (status) {
    case 'sent': return choice === 'cancel' ? 'Cancelling…' : 'Approving…'
    case 'answered':
      if (choice === 'approve') return '✓ Approved: Nandi is starting.'
      if (choice === 'cancel') return 'Plan cancelled.'
      return '✓ Answered'
    case 'denied': return 'Plan cancelled.'
    // close_prompts: decided by voice or chat, cancelled, or replaced by a changed plan.
    case 'closed': return 'Closed: answered by voice or chat, or replaced by a new plan.'
    default: return outcomeText(status)
  }
}
