import React from 'react'
import { activityTitle } from '../lib/messages.js'

/**
 * A slim pill under the core while something is in progress: a running job
 * from the brain (with its latest step and Stop), or else the request Nandi is
 * still answering. The full steps live in the console's Activity tab.
 *
 * job      the newest running activity item, or null
 * pending  the progress text of the newest unanswered request, '' while it has
 *          none yet, or null when nothing is waiting
 */
export default function JobStrip({ job, pending, onStop }) {
  if (job) {
    // Plan lines are multi-line blocks meant for the Activity tab, not a pill.
    const steps = (job.lines || []).filter(l => !/^(New plan|Plan):/.test(l.text || ''))
    const last = steps[steps.length - 1]
    return (
      <div className="job-strip" role="status">
        <span className="job-strip__spin" />
        <span className="job-strip__text">
          <b>{activityTitle(job)}</b>
          {last?.text && <span> · {last.text}</span>}
        </span>
        {job.can_stop && (
          <button className="job-strip__stop" onClick={() => onStop(job)} disabled={job.stopping}>
            {job.stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
    )
  }
  if (pending == null) return null
  return (
    <div className="job-strip" role="status">
      <span className="job-strip__spin" />
      <span className="job-strip__text">{pending || 'Thinking…'}</span>
    </div>
  )
}
