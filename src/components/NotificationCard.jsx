import React, { useState } from 'react'
import Markdown from './Markdown.jsx'
import { deliverFile } from '../lib/filesApi.js'
import { getClientId } from '../lib/clientId.js'

/**
 * A notification Nandi sent on its own — a reminder, a scheduled task's
 * result — as a card. Files it came with are opened by asking the brain to
 * show them on this screen (they arrive as a frame or file card).
 */
export default function NotificationCard({ msg }) {
  const [state, setState] = useState({})

  const show = async (id) => {
    setState(s => ({ ...s, [id]: 'opening' }))
    try {
      await deliverFile(id, { type: 'client', client_id: getClientId() })
      setState(s => ({ ...s, [id]: 'shown' }))
    } catch (err) {
      setState(s => ({ ...s, [id]: err.message || 'failed' }))
    }
  }

  return (
    <div className={`answer${msg.level === 'error' ? ' msg__error-text' : ''}`}>
      {msg.body ? <Markdown>{msg.body}</Markdown> : <p>{msg.title}</p>}
      {msg.fileIds.length > 0 && (
        <div className="fbox__actions notif__files">
          {msg.fileIds.map((id, i) => {
            const st = state[id]
            return (
              <button key={id} className="devices__btn" onClick={() => show(id)} disabled={st === 'opening'}
                title={st && st !== 'opening' && st !== 'shown' ? st : 'Show it on this screen'}>
                {st === 'opening' ? 'Opening…' : st === 'shown' ? `File ${i + 1} shown`
                  : st ? `File ${i + 1}: failed` : `Show file ${i + 1}`}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
