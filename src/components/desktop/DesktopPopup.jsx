import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from '../Markdown.jsx'
import PopupOrb from './PopupOrb.jsx'
import { PHASE } from '../../lib/voicePhase.js'
import { desktop, needsApp } from '../../lib/desktop.js'
import { popupRoot } from './popupWindow.js'
import './DesktopPopup.css'

// After Nandi goes back to sleep, the pop-up stays this long, then slides away.
const CLOSE_DELAY_MS = 2500
const LEAVE_MS = 260
// Things that arrived just before the wake word still belong to this conversation.
const EARLY_MS = 2000
const CARD_H = 200
const AWAKE = new Set([PHASE.LISTEN, PHASE.HEARING, PHASE.REPLYING, PHASE.FOLLOWUP])

function statusText(phase, voiceState, progress, secondsLeft) {
  if (phase === PHASE.LISTEN) return 'Listening…'
  if (phase === PHASE.HEARING) return 'Hearing you…'
  if (phase === PHASE.REPLYING || phase === PHASE.OPEN) {
    if (voiceState === 'speaking') return 'Speaking'
    return progress || 'Thinking…'
  }
  if (phase === PHASE.FOLLOWUP) return secondsLeft ? `Go on… (${secondsLeft} s)` : 'Go on…'
  return 'Done'
}

function orbMode(phase, voiceState) {
  if (phase === PHASE.LISTEN || phase === PHASE.HEARING || phase === PHASE.FOLLOWUP) return 'listen'
  if (phase === PHASE.REPLYING || phase === PHASE.OPEN) return voiceState === 'speaking' ? 'speak' : 'think'
  return 'idle'
}

/** A card's width in the row, from how it is tiled on the stage. */
function cardWidth(item) {
  if (item.kind === 'media') return Math.round(Math.max(170, Math.min(420, CARD_H * (item.aspect || 16 / 9))))
  if (item.kind === 'compact') return 300
  return 340
}

/**
 * The desktop app's assistant pop-up (Siri / Google Assistant style).
 *
 * When Nandi wakes and the app's own window isn't in front, a card comes up
 * above every app: the voice ribbon, what you said, her answer, and this
 * conversation's cards (pictures, files, clips, questions, jobs). When she is
 * done it slides away; the app you were in never lost the focus. What it can't
 * show (a live camera or mic, a web page) opens the app instead.
 *
 * It is drawn by this page into the window the desktop shell keeps on top
 * (popupWindow.js), so everything in it — cards, buttons, typing — is this app.
 *
 * Props:
 *   phase, voiceState, phaseUntil   the voice conversation (wakeVoice PHASE, VoiceSession state)
 *   liveUser, liveBot, progress     what is being said / answered right now
 *   lastTurn                        the latest finished exchange { at, user, reply, status }
 *   items                           everything on the stage (useStageItems)
 *   renderBody(item)                a stage item's body (the same components as the stage)
 *   micLevelRef, botLevelRef        voice levels for the ribbon
 *   appFront                        the app's window is in front: no pop-up
 *   onSend(text) → bool             type to Nandi (she answers out loud)
 *   onWake()                        talk (the globe)
 *   onOpenApp(itemId?)              bring the app forward (with that item)
 *   onShowing(ids)                  the stage items it shows now (the stage shows a placeholder for them)
 */
export default function DesktopPopup({
  phase, voiceState, phaseUntil, liveUser, liveBot, progress, lastTurn,
  items, renderBody, micLevelRef, botLevelRef, appFront, onSend, onWake, onOpenApp, onShowing,
}) {
  const awake = AWAKE.has(phase) || (phase === PHASE.OPEN && (voiceState === 'thinking' || voiceState === 'speaking'))
  const [session, setSession] = useState(null)     // { start, turns: [], leaving }
  const sessionRef = useRef(null)
  sessionRef.current = session
  const dismissed = useRef(false)                  // Esc / ✕: not again until she sleeps
  const sleptAt = useRef(0)
  const replyStart = useRef(0)
  const redirected = useRef(new Set())
  const held = useRef({ hover: false, typing: false })
  const leaveTimer = useRef(null)

  // ── open / close ────────────────────────────────────────
  const finish = useCallback(() => {
    clearTimeout(leaveTimer.current)
    if (!sessionRef.current) return
    desktop?.popup.hide()
    setSession(null)
  }, [])

  const leave = useCallback(() => {
    setSession(s => (s && !s.leaving ? { ...s, leaving: true } : s))
    clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(finish, LEAVE_MS)
  }, [finish])

  const dismiss = useCallback(() => {
    dismissed.current = true
    finish()
  }, [finish])

  useEffect(() => {
    if (!awake) {
      dismissed.current = false
      if (!sleptAt.current) sleptAt.current = Date.now()
      return
    }
    sleptAt.current = 0
    if (session?.leaving) {                    // woken again while sliding away: stay
      clearTimeout(leaveTimer.current)
      setSession(s => ({ ...s, leaving: false }))
      return
    }
    if (!session && !appFront && !dismissed.current && popupRoot()) {
      redirected.current = new Set()
      setSession({ start: Date.now(), turns: [], leaving: false })
    }
  }, [awake, appFront, session])

  // The app came to the front (clicked, or a card opened it): it takes over.
  useEffect(() => { if (appFront && session) finish() }, [appFront, session, finish])

  // Asleep: close after a moment, unless the user is reading, typing or playing something.
  useEffect(() => {
    if (!session || awake || session.leaving) return undefined
    const id = setInterval(() => {
      if (!sleptAt.current || Date.now() - sleptAt.current < CLOSE_DELAY_MS) return
      if (held.current.hover || held.current.typing || mediaPlaying()) return
      leave()
    }, 300)
    return () => clearInterval(id)
  }, [session, awake, leave])

  useEffect(() => () => clearTimeout(leaveTimer.current), [])

  // ── what it shows ───────────────────────────────────────
  useEffect(() => { if (phase === PHASE.REPLYING) replyStart.current = Date.now() }, [phase])

  // Finished exchanges of this conversation.
  useEffect(() => {
    if (!lastTurn || !session || lastTurn.at < session.start) return
    setSession(s => (s && !s.turns.some(t => t.at === lastTurn.at) ? { ...s, turns: [...s.turns, lastTurn] } : s))
  }, [lastTurn, session])

  const cards = useMemo(() => (session
    ? items.filter(it => it.at >= session.start - EARLY_MS && it.type !== 'answer' && !needsApp(it))
    : []), [items, session])

  // Something only the app can show: open it there, and step aside.
  useEffect(() => {
    if (!session) return
    const hit = items.find(it => it.at >= session.start - EARLY_MS && needsApp(it) && !redirected.current.has(it.id))
    if (!hit) return
    redirected.current.add(hit.id)
    onOpenApp(hit.id)
    dismiss()              // the conversation carries on in the app (even if the system kept its focus elsewhere)
  }, [items, session, onOpenApp, dismiss])

  const ids = useMemo(() => cards.map(c => c.id).join(','), [cards])
  useEffect(() => { onShowing(ids ? new Set(ids.split(',')) : new Set()) }, [ids, onShowing])

  if (!session) return null
  const root = popupRoot()
  if (!root) return null

  const turns = session.turns
  const lastDone = turns[turns.length - 1]
  const listening = phase === PHASE.LISTEN || phase === PHASE.HEARING
  const answering = (phase === PHASE.REPLYING || phase === PHASE.OPEN) && (!lastDone || lastDone.at < replyStart.current)
  const secondsLeft = phaseUntil ? Math.max(0, Math.ceil((phaseUntil - Date.now()) / 1000)) : 0

  return createPortal(
    <PopupCard
      leaving={session.leaving}
      status={statusText(phase, voiceState, progress, secondsLeft)}
      orb={<PopupOrb mode={orbMode(phase, voiceState)} micLevelRef={micLevelRef} botLevelRef={botLevelRef} onActivate={onWake} />}
      turns={turns}
      live={listening ? { user: liveUser, bot: '' } : answering ? { user: liveUser || lastDone?.user, bot: liveBot, thinking: voiceState !== 'speaking' && !liveBot } : null}
      cards={cards}
      renderBody={renderBody}
      held={held}
      onSend={onSend}
      onOpenApp={(id) => { onOpenApp(id); dismiss() }}
      onClose={dismiss}
    />,
    root,
  )
}

/** A clip or video playing in the pop-up keeps it open. */
function mediaPlaying() {
  const doc = popupRoot()?.ownerDocument
  if (!doc) return false
  return [...doc.querySelectorAll('audio, video')].some(m => !m.paused && !m.ended)
}

function PopupCard({ leaving, status, orb, turns, live, cards, renderBody, held, onSend, onOpenApp, onClose }) {
  const cardRef = useRef(null)
  const bodyRef = useRef(null)
  const [draft, setDraft] = useState('')
  const [entered, setEntered] = useState(false)

  // Report the card's height so the window fits it exactly, and show it.
  useLayoutEffect(() => {
    const card = cardRef.current
    const win = card.ownerDocument.defaultView
    const report = (first) => {
      const h = Math.ceil(card.getBoundingClientRect().height) + 24
      if (first) desktop?.popup.show(h)
      else desktop?.popup.resize(h)
    }
    report(true)
    const ro = new win.ResizeObserver(() => report(false))
    ro.observe(card)
    const raf = win.requestAnimationFrame(() => setEntered(true))
    return () => { ro.disconnect(); win.cancelAnimationFrame(raf) }
  }, [])

  // Keep the newest words in view.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, live?.user, live?.bot])

  // Esc closes it.
  useEffect(() => {
    const doc = cardRef.current.ownerDocument
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    doc.addEventListener('keydown', onKey)
    return () => doc.removeEventListener('keydown', onKey)
  }, [onClose])

  const maxBody = Math.round((cardRef.current?.ownerDocument.defaultView.screen.availHeight || 900) * 0.4)

  const submit = (e) => {
    e.preventDefault()
    if (draft.trim() && onSend(draft.trim())) setDraft('')
  }

  return (
    <div ref={cardRef}
      className={`dpop${entered && !leaving ? ' dpop--in' : ''}${leaving ? ' dpop--out' : ''}`}
      onMouseEnter={() => { held.current.hover = true }}
      onMouseLeave={() => { held.current.hover = false }}>
      <div className="dpop__head">
        {orb}
        <span className="dpop__status" role="status" aria-live="polite">{status}</span>
        <button className="dpop__btn" onClick={() => onOpenApp()} title="Open Nandi" aria-label="Open Nandi">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-8 8M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>
        </button>
        <button className="dpop__btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      {(turns.length > 0 || live) && (
        <div className="dpop__body" ref={bodyRef} style={{ maxHeight: maxBody }}>
          {turns.map(t => (
            <div className="dpop__turn" key={t.at}>
              {t.user && <p className="dpop__you">{t.user}</p>}
              {t.reply && <div className={`dpop__answer answer${t.status === 'error' ? ' msg__error-text' : ''}`}><Markdown>{t.reply}</Markdown></div>}
            </div>
          ))}
          {live && (
            <div className="dpop__turn dpop__turn--live">
              {live.user && <p className="dpop__you">{live.user}</p>}
              {live.bot && <p className="dpop__said">{live.bot}</p>}
              {live.thinking && <p className="dpop__thinking"><i /><i /><i /></p>}
            </div>
          )}
        </div>
      )}

      {cards.length > 0 && (
        <div className="dpop__cards">
          {cards.map(it => (
            <div key={it.id} className={`dpop__card dpop__card--${it.kind}${it.alert ? ' dpop__card--alert' : ''}`} style={{ width: cardWidth(it) }}>
              <div className="dpop__card-head">
                <span className="dpop__card-title">{it.title}</span>
                {it.source && <small className="dpop__card-source">{it.source}</small>}
                <button className="dpop__btn dpop__btn--small" onClick={() => onOpenApp(it.id)} title="Open in Nandi" aria-label="Open in Nandi">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-8 8M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>
                </button>
              </div>
              <div className="dpop__card-body">{renderBody(it)}</div>
            </div>
          ))}
        </div>
      )}

      <form className="dpop__input" onSubmit={submit}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type to Nandi…"
          aria-label="Type to Nandi"
          onFocus={() => { held.current.typing = true }}
          onBlur={() => { held.current.typing = !!draft }} />
      </form>
    </div>
  )
}
