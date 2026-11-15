import React, { useEffect, useState } from 'react'

/**
 * A device needs you: an approval ("Allow Nandi to do this?") or a question ("Which Ravi?"),
 * sent by the phone through Brain so everything happens here instead of on the phone.
 *
 * msg: { role: 'prompt', kind: 'approval'|'question', id, device, what, why, options,
 *        allowText, expiresAt, status: 'open'|'sent'|<outcome> }
 */
export default function PromptCard({ msg, onAnswer }) {
  const [now, setNow] = useState(Date.now())
  const [text, setText] = useState('')

  const open = msg.status === 'open'
  useEffect(() => {
    if (!open) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  const left = Math.max(0, Math.round((msg.expiresAt - now) / 1000))
  const expired = open && left === 0
  const live = open && !expired
  const device = msg.device === 'tab' ? 'tablet' : msg.device || 'phone'

  const answer = (frame) => {
    if (!live) return
    onAnswer(msg.id, frame)
  }

  return (
    <div className={`prompt-card prompt-card--${msg.kind} ${live ? '' : 'prompt-card--done'}`}>
      <div className="prompt-card__head">
        <span>{msg.kind === 'approval' ? `Allow Nandi to do this on your ${device}?` : `Nandi is asking (${device})`}</span>
        {live && <span className="prompt-card__timer">{left}s</span>}
      </div>
      <div className="prompt-card__what">{msg.what}</div>
      {msg.why && msg.kind === 'approval' && (
        <div className="prompt-card__why">For: {msg.why}</div>
      )}

      {live && msg.kind === 'approval' && (
        <div className="prompt-card__actions">
          <button className="prompt-card__btn prompt-card__btn--deny" onClick={() => answer({ type: 'approval_answer', allow: false })}>
            Deny
          </button>
          <button className="prompt-card__btn prompt-card__btn--allow" onClick={() => answer({ type: 'approval_answer', allow: true })}>
            Allow
          </button>
        </div>
      )}

      {live && msg.kind === 'question' && (
        <>
          <div className="prompt-card__actions prompt-card__actions--wrap">
            {(msg.options || []).map((o) => (
              <button key={o} className="prompt-card__btn" onClick={() => answer({ type: 'question_answer', answer: o })}>
                {o}
              </button>
            ))}
          </div>
          {msg.allowText && (
            <form
              className="prompt-card__reply"
              onSubmit={(e) => {
                e.preventDefault()
                if (text.trim()) answer({ type: 'question_answer', answer: text.trim() })
              }}
            >
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type an answer…" />
              <button className="prompt-card__btn" type="submit" disabled={!text.trim()}>Send</button>
            </form>
          )}
        </>
      )}

      {!live && (
        <div className="prompt-card__outcome">
          {expired ? 'No answer in time: not done.' : outcomeText(msg.status)}
        </div>
      )}
    </div>
  )
}

function outcomeText(status) {
  switch (status) {
    case 'sent': return 'Sending your answer…'
    case 'allowed': return '✓ Allowed'
    case 'denied': return '✕ Denied'
    case 'answered': return '✓ Answered'
    case 'timed_out':
    case 'timed out': return 'No answer in time: not done.'
    case 'expired': return 'This request expired.'
    case 'device unreachable': return 'The phone is not connected; nothing was done.'
    default: return status || 'Closed'
  }
}
