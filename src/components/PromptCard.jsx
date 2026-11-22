import React, { useEffect, useState } from 'react'

/**
 * Something needs your answer — from any capability, through the brain (an MCP server's
 * elicitation, or a brain feature): a confirmation ("Tap Send in WhatsApp?") or a small form
 * ("Which Ravi?"). Arrives on the display channel (lib/visionControl.js) as {action: 'prompt'}.
 *
 * msg: { role: 'prompt', id, kind: 'confirm'|'form', source, title, message, detail, device,
 *        fields: [{name, type, title, description, enum, enum_names, required, default}],
 *        suggestions, expiresAt, status: 'open'|'sent'|<outcome> }
 *
 * onAnswer(id, action: 'accept'|'decline', content)
 */
export default function PromptCard({ msg, onAnswer }) {
  const [values, setValues] = useState(() => initialValues(msg.fields))
  const { left, expired, live } = usePromptClock(msg)
  const fields = msg.fields || []
  const single = fields.length === 1 ? fields[0] : null
  const choice = single && single.type === 'string' && (single.enum || []).length > 0

  const answer = (action, content = {}) => {
    if (live) onAnswer(msg.id, action, content)
  }
  const submit = (e) => {
    e.preventDefault()
    answer('accept', values)
  }
  const missing = fields.some((f) => f.required && (values[f.name] === '' || values[f.name] == null))

  return (
    <div className={`prompt-card prompt-card--${msg.kind} ${live ? '' : 'prompt-card--done'}`}>
      <div className="prompt-card__head">
        <span>{msg.title || (msg.kind === 'confirm' ? 'Nandi needs your OK' : 'Nandi is asking')}</span>
        {live && <span className="prompt-card__timer">{left}s</span>}
      </div>
      <div className="prompt-card__what">{msg.message}</div>
      {msg.detail && <div className="prompt-card__why">For: {msg.detail}</div>}
      {msg.status === 'invalid' && <div className="prompt-card__why">That answer doesn't fit — try again.</div>}

      {live && msg.kind === 'confirm' && (
        <div className="prompt-card__actions">
          <button className="prompt-card__btn prompt-card__btn--deny" onClick={() => answer('decline')}>Deny</button>
          <button className="prompt-card__btn prompt-card__btn--allow" onClick={() => answer('accept')}>Allow</button>
        </div>
      )}

      {/* One choice: a button per option. */}
      {live && choice && (
        <div className="prompt-card__actions prompt-card__actions--wrap">
          {single.enum.map((o, i) => (
            <button key={o} className="prompt-card__btn" onClick={() => answer('accept', { [single.name]: o })}>
              {single.enum_names?.[i] || o}
            </button>
          ))}
          <button className="prompt-card__btn prompt-card__btn--deny" onClick={() => answer('decline')}>Skip</button>
        </div>
      )}

      {/* One yes/no. */}
      {live && single && single.type === 'boolean' && (
        <div className="prompt-card__actions">
          <button className="prompt-card__btn" onClick={() => answer('accept', { [single.name]: false })}>No</button>
          <button className="prompt-card__btn prompt-card__btn--allow" onClick={() => answer('accept', { [single.name]: true })}>Yes</button>
        </div>
      )}

      {/* One free answer, with quick suggestions. */}
      {live && single && !choice && single.type !== 'boolean' && (
        <>
          {(msg.suggestions || []).length > 0 && (
            <div className="prompt-card__actions prompt-card__actions--wrap">
              {msg.suggestions.map((s) => (
                <button key={s} className="prompt-card__btn" onClick={() => answer('accept', { [single.name]: s })}>{s}</button>
              ))}
            </div>
          )}
          <form className="prompt-card__reply" onSubmit={submit}>
            <input
              type={single.type === 'number' || single.type === 'integer' ? 'number' : 'text'}
              value={values[single.name] ?? ''}
              onChange={(e) => setValues({ ...values, [single.name]: e.target.value })}
              placeholder={single.description || 'Type an answer…'}
            />
            <button className="prompt-card__btn" type="submit" disabled={missing}>Send</button>
          </form>
        </>
      )}

      {/* Several fields: a small form. */}
      {live && fields.length > 1 && (
        <form className="prompt-card__form" onSubmit={submit}>
          {fields.map((f) => (
            <label key={f.name} className="prompt-card__field">
              <span>{f.title}{f.required ? ' *' : ''}</span>
              {fieldInput(f, values[f.name], (v) => setValues({ ...values, [f.name]: v }))}
              {f.description && <small>{f.description}</small>}
            </label>
          ))}
          <div className="prompt-card__actions">
            <button type="button" className="prompt-card__btn prompt-card__btn--deny" onClick={() => answer('decline')}>Decline</button>
            <button type="submit" className="prompt-card__btn prompt-card__btn--allow" disabled={missing}>Send</button>
          </div>
        </form>
      )}

      {!live && (
        <div className="prompt-card__outcome">
          {expired ? 'No answer in time: not done.' : outcomeText(msg.status)}
        </div>
      )}
    </div>
  )
}

/**
 * A prompt's countdown, shared by PromptCard and PlanCard. `open` while it can
 * still be answered here (also after an answer that did not fit); `live` while
 * open and not run out; `left` the seconds to go, or null with countdown off
 * (the card then stays live until the brain closes it).
 */
export function usePromptClock(msg, countdown = true) {
  const [now, setNow] = useState(Date.now())
  const open = msg.status === 'open' || msg.status === 'invalid'
  const ticking = open && countdown
  useEffect(() => {
    if (!ticking) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])

  const left = countdown ? Math.max(0, Math.round((msg.expiresAt - now) / 1000)) : null
  const expired = open && left === 0
  return { open, left, expired, live: open && !expired }
}

function initialValues(fields) {
  const out = {}
  for (const f of fields || []) out[f.name] = f.default ?? (f.type === 'boolean' ? false : '')
  return out
}

function fieldInput(f, value, set) {
  if (f.type === 'boolean') {
    return <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
  }
  if (f.enum && f.enum.length) {
    return (
      <select value={value ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="" disabled>Choose…</option>
        {f.enum.map((o, i) => <option key={o} value={o}>{f.enum_names?.[i] || o}</option>)}
      </select>
    )
  }
  return (
    <input
      type={f.type === 'number' || f.type === 'integer' ? 'number' : 'text'}
      value={value ?? ''}
      onChange={(e) => set(e.target.value)}
    />
  )
}

/** How a closed prompt ended, from its status (the brain's prompt_closed outcome). */
export function outcomeText(status) {
  switch (status) {
    case 'sent': return 'Sending your answer…'
    case 'allowed': return '✓ Allowed'
    case 'denied': return '✕ Denied'
    case 'answered': return '✓ Answered'
    case 'dismissed': return 'Dismissed'
    case 'not sent': return 'Not connected to Nandi right now: answer on the device.'
    case 'expired': return 'No answer in time: not done.'
    case 'finished': return 'No longer needed.'
    case 'cancelled': return 'Withdrawn.'
    case 'connection lost': return 'The device went offline; nothing was done.'
    case 'timed_out':
    case 'timed out': return 'No answer in time: not done.'
    default: return status || 'Closed'
  }
}
