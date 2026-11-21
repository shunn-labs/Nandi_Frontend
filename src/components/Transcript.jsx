import React, { useEffect, useRef } from 'react'
import Markdown from './Markdown.jsx'
import ProblemList from './ProblemList.jsx'
import { cardLabel, activityLine } from '../lib/messages.js'
import { downloadFile } from '../lib/filesApi.js'

// Closer to the bottom than this counts as "following the conversation".
const FOLLOW_THRESHOLD_PX = 80

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const PROMPT_STATUS = {
  open: 'waiting for you', sent: 'answer sent', invalid: 'answer did not fit',
  allowed: 'allowed', denied: 'denied', answered: 'answered', expired: 'expired',
}

function Line({ m }) {
  if (m.role === 'user') {
    return (
      <>
        <b className="tr__who tr__who--user">You</b>
        <span className="tr__text tr__text--user">
          {m.text}
          {m.voice && <span className="tr__via" title="Said in voice mode">voice</span>}
          {m.attachments?.map((a, i) => (
            <button key={i} type="button" className="tr__tag tr__tag--link" title="Download"
              onClick={() => downloadFile(a.file_id, a.filename).catch(err => console.warn('[files] download failed', err))}>
              📎 {a.filename}
            </button>
          ))}
        </span>
      </>
    )
  }
  if (m.role === 'ai') {
    return (
      <>
        <b className="tr__who">Nandi</b>
        <span className="tr__text">
          {m.voice && <span className="tr__via tr__via--lead" title="Said in voice mode">voice</span>}
          {m.thinking ? <i className="msg__thinking">{m.progress || 'Thinking…'}</i>
            : m.isError && !m.fromServer ? <span className="msg__error-text">{m.text}</span>
            : <div className={m.isError ? 'msg__error-text' : undefined}><Markdown>{m.text}</Markdown></div>}
          {m.errors?.length > 0 && <ProblemList errors={m.errors} />}
        </span>
      </>
    )
  }
  const what = m.role === 'prompt' ? `${m.title || m.message} · ${PROMPT_STATUS[m.status] || m.status}`
    : m.role === 'activity' ? activityLine(m)
    : m.text
  return (
    <>
      <b className="tr__who tr__who--card">{cardLabel(m)}</b>
      <span className="tr__text">{what}</span>
    </>
  )
}

/** The whole conversation, as a log in the console. */
export default function Transcript({ messages }) {
  const ref = useRef(null)
  const followRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = ref.current
    followRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < FOLLOW_THRESHOLD_PX
  }

  return (
    <div className="console__pane" ref={ref} onScroll={onScroll}>
      {messages.length === 0 && <div className="console__empty">Nothing said yet. Ctrl+L clears the conversation.</div>}
      {messages.map((m, i) => (
        <div key={m.id || `${m.role}-${m.ts}-${i}`} className="tr">
          <time className="tr__time">{time(m.ts)}</time>
          <Line m={m} />
        </div>
      ))}
    </div>
  )
}
