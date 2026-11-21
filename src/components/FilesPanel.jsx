import React, { useCallback, useEffect, useState } from 'react'
import {
  deleteFile, deliverFile, downloadFile, fileLink, humanSize, listClients, listFiles,
  updateFile, SOURCE_LABEL,
} from '../lib/filesApi.js'
import { getClientId } from '../lib/clientId.js'

const KINDS = [
  ['', 'All'], ['image', 'Images'], ['document', 'Documents'], ['audio', 'Audio'],
  ['video', 'Video'], ['other', 'Other'],
]

const when = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * Nandi's files: everything that reached Nandi (uploads, camera frames,
 * phone/PC screenshots), newest first. Each can be shown on this
 * or another of your screens, downloaded, shared as a link, sent on WhatsApp,
 * kept (automatic captures are deleted after 7 days otherwise) or deleted.
 *
 * active  the tab is visible: (re)load then, not while folded.
 */
export default function FilesPanel({ active }) {
  const [files, setFiles] = useState([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(null)   // file being sent (the inline form)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listFiles({ q: q.trim(), kind, limit: 100 })
      setFiles(Array.isArray(data?.files) ? data.files : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [q, kind])

  useEffect(() => { if (active) load() }, [active, kind])   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label, fn) => {
    setNotice('')
    try {
      const out = await fn()
      if (out) setNotice(out)
    } catch (err) {
      setNotice(`${label} failed: ${err.message}`)
    }
  }

  const show = (f) => run('Show', async () => {
    const res = await deliverFile(f.file_id, { type: 'client', client_id: getClientId() })
    return `${f.filename}: ${res.message}`
  })
  const copyLink = (f) => run('Link', async () => {
    const url = await fileLink(f.file_id)
    try {
      await navigator.clipboard.writeText(url)
      return `Link to ${f.filename} copied (valid for an hour).`
    } catch {
      window.prompt('Download link (valid for an hour):', url)
      return ''
    }
  })
  const keep = (f) => run('Keep', async () => {
    const updated = await updateFile(f.file_id, { keep: true })
    setFiles(list => list.map(x => (x.file_id === f.file_id ? updated : x)))
    return `${f.filename} will be kept.`
  })
  const remove = (f) => run('Delete', async () => {
    if (!window.confirm(`Delete ${f.filename}? This cannot be undone.`)) return ''
    await deleteFile(f.file_id)
    setFiles(list => list.filter(x => x.file_id !== f.file_id))
    return `${f.filename} deleted.`
  })

  const submit = (e) => { e.preventDefault(); load() }

  return (
    <div className="console__pane files">
      <form className="devices__stream files__bar" onSubmit={submit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, caption, camera, device…" aria-label="Search files" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button className="devices__btn" type="submit" disabled={loading}>{loading ? 'Loading…' : 'Search'}</button>
      </form>
      {error && <div className="cams__error">{error}</div>}
      {notice && <div className="files__notice">{notice}</div>}
      {!error && !loading && files.length === 0 && <div className="console__empty">No files{q || kind ? ' match' : ' yet'}.</div>}
      {files.length > 0 && (
        <table className="devices files__table">
          <tbody>
            {files.map(f => (
              <React.Fragment key={f.file_id}>
                <tr>
                  <td className="files__name" title={f.caption || f.filename}>{f.filename}</td>
                  <td>{[f.kind, humanSize(f.size)].join(' · ')}</td>
                  <td>{[SOURCE_LABEL[f.source] || f.source, f.source_ref?.camera].filter(Boolean).join(' · ')}</td>
                  <td>{when(f.created_at)}</td>
                  <td className={f.kept ? 'devices__on' : 'devices__off'}
                    title={f.kept ? 'Kept until you delete it' : `Deleted automatically on ${new Date(f.expires_at).toLocaleDateString()}`}>
                    {f.kept ? 'kept' : `until ${when(f.expires_at)}`}
                  </td>
                  <td className="files__actions">
                    <button className="devices__btn" onClick={() => show(f)}>Show</button>
                    <button className="devices__btn" onClick={() => run('Download', () => downloadFile(f.file_id, f.filename))}>Download</button>
                    <button className="devices__btn" onClick={() => copyLink(f)}>Link</button>
                    <button className="devices__btn" onClick={() => setSending(s => (s === f.file_id ? null : f.file_id))}
                      aria-expanded={sending === f.file_id}>Send…</button>
                    {!f.kept && <button className="devices__btn" onClick={() => keep(f)}>Keep</button>}
                    <button className="devices__btn" onClick={() => remove(f)}>Delete</button>
                  </td>
                </tr>
                {sending === f.file_id && (
                  <tr><td colSpan={6}>
                    <SendForm file={f} onDone={(msg) => { setSending(null); setNotice(msg) }} />
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Send one file to another of your screens, or on WhatsApp. */
function SendForm({ file, onDone }) {
  const [clients, setClients] = useState([])
  const [target, setTarget] = useState('whatsapp')
  const [number, setNumber] = useState('')
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listClients()
      .then(list => setClients(list.filter(c => c.display_connected && c.client_id !== getClientId())))
      .catch(() => setClients([]))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = target === 'whatsapp'
        ? await deliverFile(file.file_id, { type: 'whatsapp', chat_id: number.trim(), caption })
        : await deliverFile(file.file_id, { type: 'client', client_id: target })
      onDone(`${file.filename}: ${res.message}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const whatsapp = target === 'whatsapp'
  return (
    <form className="devices__stream files__send" onSubmit={submit}>
      <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Send to">
        <option value="whatsapp">WhatsApp</option>
        {clients.map(c => <option key={c.client_id} value={c.client_id}>Screen: {c.device_name}</option>)}
      </select>
      {whatsapp && (
        <>
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Number with country code, e.g. 919876543210" aria-label="WhatsApp number" required />
          <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Message (optional)" aria-label="Caption" />
        </>
      )}
      <button className="devices__btn" type="submit" disabled={busy || (whatsapp && !number.trim())}>{busy ? 'Sending…' : 'Send'}</button>
      {error && <span className="cams__error files__inline-error">{error}</span>}
    </form>
  )
}
