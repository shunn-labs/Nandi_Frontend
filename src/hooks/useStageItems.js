import { useMemo, useRef } from 'react'
import { cardLabel, isOpenPrompt, needsPanel } from '../lib/messages.js'
import { viewerFor } from '../lib/fileKinds.js'

// Only the newest long answers keep a window by themselves (an answer reopened
// from the transcript gets one too); older ones live in the transcript.
const MAX_ANSWER_WINDOWS = 3
// Shape of a picture's window until the picture has loaded.
const DEFAULT_ASPECT = 16 / 9
const PHOTO_ASPECT = 4 / 3

// ── How long a window stays before it closes by itself (Stage enforces it) ──
// Something to read: 20 s plus a quarter second per word, at most 2 minutes,
// counted once Nandi has stopped speaking.
const READ_BASE_MS = 20000
const READ_PER_WORD_MS = 250
const READ_MAX_MS = 120000
// A snapshot, a file or a clip: a minute and a half from when it opened.
export const MEDIA_MS = 90000
// An answered prompt, and a finished job: their outcome stays readable this long.
const DONE_PROMPT_MS = 4000
const DONE_JOB_MS = 60000

/** Reading time for a text window. */
export function readingMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return Math.min(READ_MAX_MS, READ_BASE_MS + words * READ_PER_WORD_MS)
}

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

/** Live views (a camera, a stream, a live mic) never close by themselves. */
export const isLiveBox = (b) => b.type === 'stream' || b.type === 'camera' || b.type === 'audio_stream'
/** A picture on the stage: a snapshot, or an image file. */
export const isImageBox = (b) => b.type === 'frame' || (b.type === 'file' && viewerFor(b.file || {}).viewer === 'image')

// closeMs / closeFrom / closeAfterSpeech: when the window closes by itself
// (none = never). closeFrom is when the countdown starts (default: when the
// window appeared); closeAfterSpeech holds it while Nandi is still talking.
const FIELDS = ['at', 'type', 'kind', 'title', 'source', 'alert', 'aspect', 'data', 'closeMs', 'closeFrom', 'closeAfterSpeech']
const same = (a, b) => FIELDS.every(k => a[k] === b[k])

/**
 * Everything that goes on the stage, as window descriptors in the order they
 * appeared:
 *
 *   { id, at, type, kind, title, source, alert, aspect, data,
 *     closeMs, closeFrom, closeAfterSpeech }
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
  // When this screen first saw each prompt answered (its 4 s count from then,
  // not from the last message that happened to arrive).
  const promptDone = useRef(new Map())

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
        closeMs: isLiveBox(b) ? undefined : MEDIA_MS, closeFrom: undefined, closeAfterSpeech: false,
      })
    }

    const answers = new Set(messages.filter(m => m.role === 'ai' && m.panel).slice(-MAX_ANSWER_WINDOWS))
    for (const m of messages) if (m.role === 'ai' && m.reopenedAt && !m.thinking) answers.add(m)
    const seenDone = promptDone.current
    for (const m of messages) {
      if (hidden.has(m.id)) continue
      if (m.role === 'prompt') {
        const open = isOpenPrompt(m)
        if (!open && !seenDone.has(m.id)) seenDone.set(m.id, Date.now())
        add({
          id: m.id, at: m.ts, type: m.plan ? 'plan' : 'prompt', kind: 'panel', alert: open,
          title: m.plan ? 'Plan' : cardLabel(m), source: open ? 'needs your answer' : 'done', aspect: undefined, data: m,
          closeMs: open ? undefined : DONE_PROMPT_MS, closeFrom: open ? undefined : seenDone.get(m.id), closeAfterSpeech: false,
        })
      } else if (m.role === 'activity' && m.source === 'job') {
        // A job's live window. Other activities stay in the console's
        // Activity tab and the pill by the core.
        const running = m.state !== 'done'
        add({
          id: m.id, at: m.ts, type: 'job', kind: 'panel', alert: false, title: 'Job', aspect: undefined, data: m,
          source: !running ? 'finished' : m.total > 0 ? `working · ${m.progress || 0} of ${m.total}` : 'working',
          closeMs: running ? undefined : DONE_JOB_MS, closeFrom: running ? undefined : (m.doneAt || undefined),
          closeAfterSpeech: false,
        })
      } else if (m.role === 'notification' && (m.fileIds.length > 0 || needsPanel(m.body, []))) {
        add({
          id: m.id, at: m.ts, type: 'notification', kind: 'panel', alert: m.level === 'error', title: m.title,
          source: `${cardLabel(m).toLowerCase()} · ${time(m.ts)}`, aspect: undefined, data: m,
          closeMs: readingMs(`${m.title} ${m.body}`), closeFrom: undefined, closeAfterSpeech: true,
        })
      } else if (answers.has(m)) {
        add({
          id: m.id, at: m.reopenedAt || m.ts, type: 'answer', kind: 'doc', alert: false,
          title: m.history ? 'Earlier answer' : 'Answer', source: time(m.ts), aspect: undefined, data: m,
          closeMs: readingMs(m.text), closeFrom: undefined, closeAfterSpeech: true,
        })
      }
    }

    cache.current = next
    return list.sort((a, b) => a.at - b.at)
  }, [boxes, aspects, messages, hidden])
}
