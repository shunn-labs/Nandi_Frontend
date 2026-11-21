import React, { useCallback, useEffect, useState } from 'react'
import { listTasks, taskAction, taskRuns } from '../lib/filesApi.js'
import { actionText, scheduleText, waitingText, whenText } from '../lib/taskText.js'

/**
 * What Nandi has been asked to do later: reminders, repeating jobs and
 * tasks that wait for an event. Each row says when it runs (or what it is
 * waiting for), what it will do, and where the result goes; it can be paused,
 * resumed, run now or cancelled, and its past runs opened.
 *
 * active   the tab is visible: (re)load then.
 * version  bumped by the brain's `tasks_changed` frames, so the list follows
 *          tasks created in chat, runs and status changes without a refresh.
 */
export default function TasksPanel({ active, version }) {
  const [tasks, setTasks] = useState([])
  const [finished, setFinished] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(null)          // task whose runs are shown
  const [, setTick] = useState(0)                 // re-render so "in 5 min" stays true

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTasks(await listTasks({ includeFinished: finished }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [finished])

  useEffect(() => { if (active) load() }, [active, version, load])
  useEffect(() => {
    if (!active) return undefined
    const id = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [active])

  const act = async (task, action) => {
    setNotice('')
    if (action === 'cancel' && !window.confirm(`Cancel "${task.title}"? It will not run again.`)) return
    try {
      await taskAction(task.task_id, action)
      setNotice({
        pause: `"${task.title}" paused.`, resume: `"${task.title}" resumed.`,
        cancel: `"${task.title}" cancelled.`, run: `"${task.title}" is running now.`,
      }[action])
      load()
    } catch (err) {
      setNotice(`Could not ${action} "${task.title}": ${err.message}`)
    }
  }

  const live = tasks.filter(t => t.status === 'active' || t.status === 'paused')
  const ended = tasks.filter(t => !(t.status === 'active' || t.status === 'paused'))

  return (
    <div className="console__pane tasks">
      <div className="devices__stream files__bar">
        <span className="tasks__summary">
          {live.length ? `${live.length} scheduled` : 'Nothing scheduled'}
          {live.some(t => t.status === 'paused') && ` · ${live.filter(t => t.status === 'paused').length} paused`}
        </span>
        <label className="tasks__toggle">
          <input type="checkbox" checked={finished} onChange={(e) => setFinished(e.target.checked)} />
          Show finished
        </label>
        <button className="devices__btn" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <div className="cams__error">{error}</div>}
      {notice && <div className="files__notice">{notice}</div>}
      {!error && !loading && tasks.length === 0 && (
        <div className="console__empty">
          No tasks yet. Ask Nandi, e.g. “remind me in 10 minutes to call Ravi” or
          “every weekday at 8am check the gate camera”.
        </div>
      )}
      {tasks.length > 0 && (
        <table className="devices tasks__table">
          <tbody>
            {[...live, ...ended].map(t => {
              const { what, to } = actionText(t)
              return (
                <React.Fragment key={t.task_id}>
                  <tr className={t.status === 'active' ? '' : 'tasks__row--dim'}>
                    <td className="tasks__title">
                      <strong>{t.title}</strong>
                      <span className="tasks__what" title={what}>{what}</span>
                    </td>
                    <td>{scheduleText(t)}{t.max_runs ? ` · ${t.run_count}/${t.max_runs} runs` : ''}</td>
                    <td className={t.status === 'active' ? 'devices__on' : 'devices__off'}>{waitingText(t)}</td>
                    <td title="Where the result goes">→ {to}</td>
                    <td className="tasks__last" title={t.last_run_at ? new Date(t.last_run_at).toLocaleString() : ''}>
                      {t.last_run_at
                        ? `last ran ${whenText(t.last_run_at)}${t.run_count ? ` · ${t.run_count} scheduled run${t.run_count === 1 ? '' : 's'}` : ''}`
                        : 'not run yet'}
                    </td>
                    <td className="files__actions">
                      {t.status === 'active' && <button className="devices__btn" onClick={() => act(t, 'pause')}>Pause</button>}
                      {t.status === 'paused' && <button className="devices__btn" onClick={() => act(t, 'resume')}>Resume</button>}
                      {t.status !== 'cancelled' && <button className="devices__btn" onClick={() => act(t, 'run')} title="Run once now, outside the schedule">Run now</button>}
                      <button className="devices__btn" onClick={() => setOpen(o => (o === t.task_id ? null : t.task_id))}
                        aria-expanded={open === t.task_id}>History</button>
                      {(t.status === 'active' || t.status === 'paused') &&
                        <button className="devices__btn" onClick={() => act(t, 'cancel')}>Cancel</button>}
                    </td>
                  </tr>
                  {open === t.task_id && (
                    <tr><td colSpan={6}><RunHistory taskId={t.task_id} version={version} /></td></tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The last runs of one task: when, how it went, what it said. */
function RunHistory({ taskId, version }) {
  const [runs, setRuns] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    taskRuns(taskId).then(setRuns).catch(err => setError(err.message))
  }, [taskId, version])

  if (error) return <div className="cams__error">{error}</div>
  if (!runs) return <div className="console__empty">Loading…</div>
  if (!runs.length) return <div className="console__empty">It has not run yet.</div>
  return (
    <ul className="tasks__runs">
      {runs.map(r => (
        <li key={r.run_id}>
          <span className={r.status === 'ok' ? 'devices__on' : r.status ? 'devices__off' : ''}>
            {r.status || 'running'}
          </span>
          {' '}{whenText(r.started_at)}{r.trigger_ref?.manual ? ' · run by hand' : ''}
          {r.output && <div className="tasks__output">{r.output}</div>}
          {(r.errors || []).map((e, i) => (
            <div key={i} className="cams__error">{typeof e === 'string' ? e : e.message || e.error || JSON.stringify(e)}</div>
          ))}
        </li>
      ))}
    </ul>
  )
}
