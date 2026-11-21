import React, { useEffect } from 'react'

const TOAST_MS = 6000

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast.id, onDismiss])

  return (
    <div className={`toast${toast.tone ? ` toast--${toast.tone}` : ''}`} role="status">
      <div className="toast__text">
        <b>{toast.title}</b>
        {toast.body && <span>{toast.body}</span>}
      </div>
      <button className="toast__close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  )
}

/**
 * Short notices for things that happen on their own (a phone event, a camera
 * that would not start). They slide in at the top right and leave by themselves.
 *
 * toasts  [{ id, title, body, tone: 'alert' | undefined }]
 */
export default function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(t => <Toast key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  )
}
