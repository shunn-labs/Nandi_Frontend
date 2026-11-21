import React from 'react'

/**
 * The structured errors attached to an answer: a camera that was offline, a
 * tool that failed. Collapsed by default: the answer already says in words
 * what went wrong, and this is the detail behind it.
 *
 * errors  [{ stage, source, message, hint }]
 */
export default function ProblemList({ errors }) {
  return (
    <details className="msg__problems">
      <summary>⚠ {errors.length} {errors.length === 1 ? 'problem' : 'problems'}</summary>
      <ul>
        {errors.map((err, i) => {
          const where = [err.stage, err.source].filter(Boolean).join(' · ')
          return (
            <li key={i}>
              {where && <span className="msg__problem-where">{where}</span>}
              {where && err.message && ' — '}
              {err.message}
              {err.hint && <span className="msg__problem-hint">Fix: {err.hint}</span>}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
