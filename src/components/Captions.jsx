import React, { useEffect, useState } from 'react'
import Markdown from './Markdown.jsx'

const FADE_AFTER_MS = 8000

/**
 * Subtitles at the bottom of the stage: what you last said, and Nandi's reply.
 * A long reply opens as a panel instead, so here it is cut to its first
 * sentence. They fade out a while after the reply, unless `hold` is set (Nandi
 * is still thinking or speaking).
 *
 * caption  { key, echo, text, isError, short } or null
 */
export default function Captions({ caption, hold }) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!caption) return undefined
    setShown(true)
    if (hold) return undefined
    const t = setTimeout(() => setShown(false), FADE_AFTER_MS)
    return () => clearTimeout(t)
  }, [caption, hold])

  if (!caption) return null
  return (
    <div className={`captions${shown ? ' captions--on' : ''}`} aria-live="polite">
      {caption.echo && <div className="captions__echo">{caption.echo}</div>}
      {caption.text && (
        <div className={`captions__text${caption.isError ? ' captions__text--error' : ''}`}>
          {caption.short ? caption.text : <Markdown>{caption.text}</Markdown>}
        </div>
      )}
    </div>
  )
}
