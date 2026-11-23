import React, { memo, useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import {
  absoluteUrl, downloadFile, fetchFileBlob, fetchFileText, fetchPreview, fileLink, humanSize, SOURCE_LABEL,
} from '../lib/filesApi.js'
import { viewerFor } from '../lib/fileKinds.js'

const PDF_MAX_BYTES = 40 * 1024 * 1024
const TEXT_MAX_BYTES = 512 * 1024
const CSV_MAX_ROWS = 500
const LINK_TTL_S = 12 * 3600      // a fresh link for a window left open a long time

// Put in front of an HTML file shown in a window. The iframe is sandboxed (no
// scripts, no same-origin); this also stops it loading anything from the
// network (tracking pixels, remote fonts) — only inline styles and data: images.
const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`

/**
 * A file from Nandi's file store, shown inside its window:
 *
 *   image / video / audio   the signed link (a fresh one is fetched if it
 *                           expired; a video keeps its place)
 *   pdf                     fetched with the login → blob URL → the browser's
 *                           own PDF viewer (the /f/ link's sandbox CSP would
 *                           block it)
 *   markdown, text, json,   the first 512 KB as text
 *   csv
 *   html                    a sandboxed iframe with no network access
 *   Word / Excel / …        the brain's text or table preview
 *   anything else           name and size; Download / Open
 *
 * Effects depend on the file id only: the window re-rendering (or the brain
 * re-sending the file with a new link) does not reload what is showing.
 *
 * box      { id, file: {file_id, filename, mime, size, kind, source}, url, preview }
 * onAspect(ratio)  a picture's or video's shape, once known
 */
function FileViewer({ box, onAspect }) {
  const f = box.file || {}
  const { viewer } = viewerFor(f)
  const id = f.file_id || ''
  const [error, setError] = useState('')
  const [pdfUrl, setPdfUrl] = useState('')
  const link = absoluteUrl(box.url)

  const save = async () => {
    setError('')
    try { await downloadFile(id, f.filename) } catch (err) { setError(err.message) }
  }
  // A PDF opens from its blob (the link's sandbox would block the viewer).
  const openHref = viewer === 'pdf' ? pdfUrl : link

  let body
  if (!id && !link) body = <Empty f={f} label={box.label} />
  else if (viewer === 'image' || viewer === 'video' || viewer === 'audio') {
    body = <MediaFile kind={viewer} fileId={id} url={box.url} label={f.filename || box.label} onAspect={onAspect} />
  } else if (viewer === 'pdf') body = <PdfView fileId={id} size={f.size} title={f.filename || box.label} onUrl={setPdfUrl} />
  else if (viewer === 'html') body = <HtmlView fileId={id} size={f.size} title={f.filename || box.label} />
  else if (viewer === 'markdown' || viewer === 'text' || viewer === 'json' || viewer === 'csv') {
    body = <TextView fileId={id} size={f.size} viewer={viewer} tsv={/\.tsv$/i.test(f.filename || '')} />
  } else if (viewer === 'preview') body = <PreviewView fileId={id} preview={box.preview} f={f} label={box.label} />
  else body = <Empty f={f} label={box.label} />

  return (
    <div className={`fview fview--${viewer}`}>
      <div className="fview__main">{body}</div>
      <div className="fview__tools">
        <button className="vbox__tool" onClick={save} disabled={!id} title={error || 'Download to this device'}>
          {error ? 'Failed' : 'Download'}
        </button>
        {openHref && <a className="vbox__tool fview__open" href={openHref} target="_blank" rel="noreferrer">Open</a>}
      </div>
    </div>
  )
}

export default memo(FileViewer)

/** Name, size and where it came from: for files with nothing to show inline. */
function Empty({ f, label }) {
  return (
    <div className="fview__empty">
      <b title={f.filename}>{f.filename || label}</b>
      <span>{[f.kind || 'file', humanSize(f.size), SOURCE_LABEL[f.source] || f.source].filter(Boolean).join(' · ')}</span>
      {f.caption && <span className="fview__caption">{f.caption}</span>}
    </div>
  )
}

function Note({ children }) {
  return <div className="fview__note">{children}</div>
}

/** A picture, video or sound from its signed link; refreshes an expired link once per failure. */
function MediaFile({ kind, fileId, url, label, onAspect }) {
  const [src, setSrc] = useState(() => absoluteUrl(url))
  const [failed, setFailed] = useState(false)
  const elRef = useRef(null)
  const retry = useRef({ busy: false, used: false, time: 0 })

  // No link came with it (a file opened by id): ask for one.
  useEffect(() => {
    if (src || !fileId) return undefined
    let live = true
    fileLink(fileId, LINK_TTL_S).then(u => { if (live) setSrc(u) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps

  const onError = async () => {
    const r = retry.current
    if (r.busy) return
    if (r.used || !fileId) { setFailed(true); return }
    r.busy = true; r.used = true
    r.time = elRef.current?.currentTime || 0
    try { setSrc(await fileLink(fileId, LINK_TTL_S)) } catch { setFailed(true) } finally { r.busy = false }
  }
  const onLoaded = (e) => {
    const el = e.currentTarget
    if (kind === 'image' && el.naturalWidth && el.naturalHeight) onAspect?.(el.naturalWidth / el.naturalHeight)
    if (kind === 'video' && el.videoWidth && el.videoHeight) onAspect?.(el.videoWidth / el.videoHeight)
    if (kind !== 'image' && retry.current.time) { el.currentTime = retry.current.time; retry.current.time = 0 }
    // Loaded fine: a later expiry may be refreshed again.
    retry.current.used = false
  }

  if (failed) return <Note>This file could not be loaded. Try Download.</Note>
  if (!src) return <Note>Loading…</Note>
  if (kind === 'image') {
    return <img ref={elRef} className="fview__img" src={src} alt={label} draggable={false} onLoad={onLoaded} onError={onError} />
  }
  if (kind === 'video') {
    return <video ref={elRef} className="fview__video" src={src} controls playsInline preload="metadata"
      onLoadedMetadata={onLoaded} onError={onError} />
  }
  return (
    <div className="fview__audio">
      <audio ref={elRef} src={src} controls preload="metadata" onLoadedMetadata={onLoaded} onError={onError} />
    </div>
  )
}

/** Fetches a file once (per id) and hands the result to `use`; aborts on unmount. */
function useFetched(fileId, load) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    if (!fileId) { setState({ error: 'No file to show' }); return undefined }
    const ctl = new AbortController()
    setState({ loading: true })
    load(ctl.signal)
      .then(value => { if (!ctl.signal.aborted) setState({ value }) })
      .catch(err => { if (!ctl.signal.aborted) setState({ error: err?.message || 'Could not load the file', tooLarge: !!err?.tooLarge }) })
    return () => ctl.abort()
  }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

function PdfView({ fileId, size, title, onUrl }) {
  const tooBig = size > PDF_MAX_BYTES
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (tooBig || !fileId) return undefined
    const ctl = new AbortController()
    let made = ''
    fetchFileBlob(fileId, { maxBytes: PDF_MAX_BYTES, signal: ctl.signal })
      .then(blob => {
        made = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }))
        setUrl(made)
        onUrl?.(made)
      })
      .catch(err => { if (!ctl.signal.aborted) setError(err?.tooLarge ? 'too-large' : err?.message || 'failed') })
    return () => {
      ctl.abort()
      if (made) URL.revokeObjectURL(made)
      onUrl?.('')
    }
  }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (tooBig || error === 'too-large') return <Note>This PDF is too large to show here ({humanSize(size)}). Use Download.</Note>
  if (error) return <Note>{error}</Note>
  if (!url) return <Note>Loading the PDF…</Note>
  return <iframe className="fview__frame" src={url} title={title} />
}

function HtmlView({ fileId, size, title }) {
  const st = useFetched(fileId, (signal) => fetchFileText(fileId, { maxBytes: TEXT_MAX_BYTES, size, signal }))
  if (st.error) return <Note>{st.error}</Note>
  if (!st.value) return <Note>Loading…</Note>
  return <iframe className="fview__frame fview__frame--html" sandbox="" srcDoc={HTML_CSP + st.value.text} title={title} />
}

function TextView({ fileId, size, viewer, tsv }) {
  const st = useFetched(fileId, (signal) => fetchFileText(fileId, { maxBytes: TEXT_MAX_BYTES, size, signal }))
  if (st.error) return <Note>{st.error}</Note>
  if (!st.value) return <Note>Loading…</Note>
  const { text, truncated } = st.value
  const cut = truncated && <div className="fview__cut">Showing the first {humanSize(TEXT_MAX_BYTES)} — download for the rest.</div>
  if (viewer === 'markdown') return <div className="fview__doc"><Markdown>{text}</Markdown>{cut}</div>
  if (viewer === 'csv') return <div className="fview__doc"><CsvTable text={text} delimiter={tsv ? '\t' : ','} />{cut}</div>
  let shown = text
  if (viewer === 'json' && !truncated) {
    try { shown = JSON.stringify(JSON.parse(text), null, 2) } catch { /* not valid JSON: as it is */ }
  }
  return <div className="fview__doc"><pre className="fview__pre">{shown}</pre>{cut}</div>
}

function PreviewView({ fileId, preview, f, label }) {
  const st = useFetched(fileId, (signal) => (preview ? Promise.resolve(preview) : fetchPreview(fileId, { signal })))
  if (st.loading) return <Note>Loading a preview…</Note>
  const p = st.value
  if (!p) return <Empty f={f} label={label} />
  return (
    <div className="fview__doc">
      {p.format === 'text' ? <pre className="fview__pre">{p.text}</pre> : <Markdown>{p.text}</Markdown>}
      {p.truncated && <div className="fview__cut">Preview of the start — download for the whole file.</div>}
    </div>
  )
}

/** A CSV as a table (quotes and doubled quotes handled; at most 500 rows). */
function CsvTable({ text, delimiter }) {
  const rows = parseCsv(text, delimiter, CSV_MAX_ROWS + 1)
  if (!rows.length) return <Note>Empty table.</Note>
  const [head, ...body] = rows
  const shown = body.slice(0, CSV_MAX_ROWS)
  return (
    <>
      <table className="fview__table">
        <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{shown.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
      {body.length > CSV_MAX_ROWS && <div className="fview__cut">First {CSV_MAX_ROWS} rows.</div>}
    </>
  )
}

function parseCsv(text, delimiter, maxRows) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += ch
  }
  if ((field || row.length) && rows.length < maxRows) { row.push(field); rows.push(row) }
  return rows
}
