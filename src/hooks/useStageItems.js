import { useMemo, useRef } from 'react'
import { cardLabel, isOpenPrompt, needsPanel } from '../lib/messages.js'
import { viewerFor } from '../lib/fileKinds.js'

// Only the newest long answers keep a window; older ones live in the transcript.
const MAX_ANSWER_WINDOWS = 3
// Shape of a picture's window until the picture has loaded.
const DEFAULT_ASPECT = 16 / 9
const PHOTO_ASPECT = 4 / 3

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// What a vision window shows under its title: what it is and where it comes
// from (the stream id, or the camera a snapshot was taken from).
function visionSource(b) {
  if (b.type === 'frame') return b.camera ? `snapshot · ${b.camera}` : 'snapshot'
  if (b.type === 'file') return `file · ${viewerFor(b.file || {}).label}`
  if (b.type === 'audio') return 'audio clip'
  if (b.type === 'audio_stream') return `live audio · ${b.streamId}`
  return `${b.type === 'camera' ? 'this device' : 'live'} · ${b.streamId}`
}

/** The tiling kind of a vision box (lib/tiling.js): media, doc or compact. */
function boxKind(b) {
  if (b.type === 'audio' || b.type === 'audio_stream') return 'compact'
  if (b.type !== 'file') return 'media'
  const v = viewerFor(b.file || {}).viewer
  if (v === 'image' || v === 'video') return 'media'
  if (v === 'audio' || v === 'none') return 'compact'
  return 'doc'
}

const FIELDS = ['at', 'type', 'kind', 'title', 'source', 'alert', 'aspect', 'data']
const same = (a, b) => FIELDS.every(k => a[k] === b[k])

/**
 * Everything that goes on the stage, as window descriptors in the order they
 * appeared:
 *
 *   { id, at, type, kind, title, source, alert, aspect, data }
 *     type  vision | prompt | plan | job | notification | answer
 *     kind  media | doc | panel | compact   (how the window is tiled)
 *     data  the vision box or the message it shows
 *
 * A descriptor whose box or message did not change is the *same object* as
 * last time. The stage's windows are memoised on it, so a job's progress
 * frame re-renders the job's window and nothing else — the other windows (a
 * playing video, a PDF) no longer re-render, let alone blink.
 */
export default function useStageItems({ boxes, aspects, messages, hidden }) {
  const cache = useRef(new Map())

  return useMemo(() => {
    const prev = cache.current
    const next = new Map()
    const list = []
    const add = (d) => {
      const old = prev.get(d.id)
      const item = old && same(old, d) ? old : d
      next.set(d.id, item)
      list.push(item)
    }

    for (const b of boxes) {
      const kind = boxKind(b)
      const fallback = b.type === 'file' && viewerFor(b.file || {}).viewer === 'image' ? PHOTO_ASPECT : DEFAULT_ASPECT
      add({
        id: b.id, at: b.at, type: 'vision', kind, title: b.label, source: visionSource(b), alert: false,
        aspect: kind === 'media' ? (aspects[b.id] || fallback) : undefined, data: b,
      })
    }

    const answers = new Set(messages.filter(m => m.role === 'ai' && m.panel).slice(-MAX_ANSWER_WINDOWS))
    for (const m of messages) {
      if (hidden.has(m.id)) continue
      if (m.role === 'prompt') {
        const open = isOpenPrompt(m)
        add({
          id: m.id, at: m.ts, type: m.plan ? 'plan' : 'prompt', kind: 'panel', alert: open,
          title: m.plan ? 'Plan' : cardLabel(m), source: open ? 'needs your answer' : 'done', aspect: undefined, data: m,
        })
      } else if (m.role === 'activity' && m.source === 'job') {
        // A job's live window. Other activities stay in the console's
        // Activity tab and the pill by the core.
        const running = m.state !== 'done'
        add({
          id: m.id, at: m.ts, type: 'job', kind: 'panel', alert: false, title: 'Job', aspect: undefined, data: m,
          source: !running ? 'finished' : m.total > 0 ? `working · ${m.progress || 0} of ${m.total}` : 'working',
        })
      } else if (m.role === 'notification' && (m.fileIds.length > 0 || needsPanel(m.body, []))) {
        add({
          id: m.id, at: m.ts, type: 'notification', kind: 'panel', alert: m.level === 'error', title: m.title,
          source: `${cardLabel(m).toLowerCase()} · ${time(m.ts)}`, aspect: undefined, data: m,
        })
      } else if (answers.has(m)) {
        add({ id: m.id, at: m.ts, type: 'answer', kind: 'doc', alert: false, title: 'Answer', source: time(m.ts), aspect: undefined, data: m })
      }
    }

    cache.current = next
    return list.sort((a, b) => a.at - b.at)
  }, [boxes, aspects, messages, hidden])
}
