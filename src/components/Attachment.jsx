import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  useEffect,
  useCallback,
} from 'react'
import { uploadFile } from '../lib/wsAdapter.js'

let _counter = 0
const nextId = () => `att_${++_counter}`

function truncate(str, n = 20) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

function fileIcon(type = '') {
  if (type.startsWith('image/'))  return '🖼️'
  if (type.startsWith('video/'))  return '🎥'
  if (type.startsWith('audio/'))  return '🎵'
  if (type.includes('pdf'))       return '📄'
  if (type.includes('zip') || type.includes('tar')) return '🗜️'
  if (type.includes('text') || type.includes('json') || type.includes('javascript') || type.includes('python'))
    return '📝'
  return '📎'
}

const Attachment = forwardRef(function Attachment({ onChange }, ref) {
  const [items, setItems] = useState([])
  const fileInputRef = useRef(null)

  // Notify parent via useEffect (avoids render-phase state update warning)
  useEffect(() => {
    if (!onChange) return
    const ready = items
      .filter(f => f.status === 'done')
      .map(({ file_id, filename, content_type, file_size_bytes }) => ({
        file_id,
        filename,
        content_type,
        file_size_bytes,
      }))
    const uploading = items.some(f => f.status === 'uploading')
    onChange(ready, uploading)
  }, [items, onChange])

  useImperativeHandle(ref, () => ({
    triggerSelect: () => fileInputRef.current?.click(),
    clear: () => {
      setItems(prev => {
        prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) })
        return []
      })
    },
    hasItems: () => items.length > 0,
  }))

  const uploadItem = useCallback(async (id, file) => {
    const timer = setInterval(() => {
      setItems(prev => prev.map(f =>
        f.id === id && f.status === 'uploading'
          ? { ...f, progress: Math.min(f.progress + 12, 85) }
          : f
      ))
    }, 280)

    try {
      const result = await uploadFile(file)
      clearInterval(timer)
      setItems(prev => prev.map(f =>
        f.id === id
          ? { ...f, status: 'done', progress: 100, file_id: result.file_id, file_size_bytes: result.file_size_bytes }
          : f
      ))
    } catch (err) {
      clearInterval(timer)
      console.error(`[att] upload failed: ${file.name}`, err)
      setItems(prev => prev.map(f =>
        f.id === id ? { ...f, status: 'error', progress: 0 } : f
      ))
    }
  }, [])

  const addFiles = useCallback((fileList) => {
    const newItems = Array.from(fileList).map(file => ({
      id: nextId(),
      file,
      filename: file.name,
      size: file.size,
      content_type: file.type || 'application/octet-stream',
      status: 'uploading',
      progress: 0,
      preview: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null,
      file_id: null,
    }))
    setItems(prev => [...prev, ...newItems])
    newItems.forEach(item => uploadItem(item.id, item.file))
  }, [uploadItem])

  // Listen for globally dropped files (from ChatView's drag-and-drop)
  useEffect(() => {
    const handler = (e) => addFiles(e.detail)
    window.addEventListener('nandi-drop-files', handler)
    return () => window.removeEventListener('nandi-drop-files', handler)
  }, [addFiles])

  const removeFile = useCallback((id) => {
    setItems(prev => {
      const target = prev.find(f => f.id === id)
      if (target?.preview) URL.revokeObjectURL(target.preview)
      return prev.filter(f => f.id !== id)
    })
  }, [])

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {items.length > 0 && (
        <div className="att-strip">
          {items.map(item => (
            <div key={item.id} className="att-chip">
              <span className="att-chip__icon">{fileIcon(item.content_type)}</span>
              <span className="att-chip__name">{truncate(item.filename)}</span>
              {item.status === 'uploading' && (
                <div className="att-chip__progress" style={{ width: `${item.progress}%` }} />
              )}
              {item.status === 'done' && (
                <span className="att-chip__status att-chip__status--ok">✓</span>
              )}
              {item.status === 'error' && (
                <span className="att-chip__status att-chip__status--err">✕</span>
              )}
              <button
                className="att-chip__rm"
                disabled={item.status === 'uploading'}
                onClick={() => removeFile(item.id)}
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
})

export default Attachment
