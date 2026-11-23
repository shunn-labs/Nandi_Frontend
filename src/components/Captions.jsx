import React, { memo, useEffect, useState } from 'react'
import Markdown from './Markdown.jsx'

const FADE_AFTER_MS = 8000

/**
 * Subtitles: what you last said, and Nandi's reply. A long reply opens as a
 * window instead, so here it is cut to its first sentence.
 *
 * In the middle (nothing on the stage) they fade out a while after the reply,
 * unless `hold` is set (Nandi is still thinking or speaking).
 *
 * Docked (windows on the stage) they sit in the bottom dock, right of the
 * core, as the latest command → response pair: one line for what you said,
 * at most two for the reply, and they stay until the next exchange.
 *
 * caption  { key, echo, text, isError, short } or null
 */
function Captions({ caption, hold, docked }) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!caption) return undefined
    setShown(true)
    if (hold || docked) return undefined
    const t = setTimeout(() => setShown(false), FADE_AFTER_MS)
    return () => clearTimeout(t)
  }, [caption, hold, docked])

  if (!caption) return null
  return (
    <div className={`captions${shown || docked ? ' captions--on' : ''}${docked ? ' captions--docked' : ''}`} aria-live="polite">
      {caption.echo && <div className="captions__echo" title={caption.echo}>{caption.echo}</div>}
      {caption.text && (
        <div className={`captions__text${caption.isError ? ' captions__text--error' : ''}`}>
          {caption.short ? caption.text : <Markdown>{caption.text}</Markdown>}
        </div>
      )}
    </div>
  )
}

export default memo(Captions)
