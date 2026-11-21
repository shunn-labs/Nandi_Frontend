import React, { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Ctrl+K: every action in one searchable list.
 *
 * commands  [{ label, hint, onSelect }]
 */
export default function CommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands
  }, [commands, query])

  const run = (cmd) => { onClose(); cmd?.onSelect() }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(matches.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(matches[index]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  return (
    <div className="palette" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette__box" role="dialog" aria-label="Commands">
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Type a command"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
          onKeyDown={onKeyDown}
          aria-label="Search commands"
        />
        <ul className="palette__list" role="listbox">
          {matches.length === 0 && <li className="palette__empty">No matching command</li>}
          {matches.map((c, i) => (
            <li key={c.label} role="option" aria-selected={i === index}
              className={`palette__item${i === index ? ' palette__item--on' : ''}`}
              onPointerMove={() => setIndex(i)} onClick={() => run(c)}>
              <span>{c.label}</span>
              {c.hint && <small>{c.hint}</small>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
