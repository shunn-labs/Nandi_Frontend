// Which viewer a file from Nandi's file store opens in, from its MIME type
// and name. Shared by the stage (a picture is tiled like media, a PDF like a
// page) and FileViewer (which draws it).
//
//   image | video | audio | pdf | html | markdown | csv | json | text
//   preview   Word / Excel / PowerPoint / OpenDocument: the brain renders a
//             text or table preview (show_file `preview`, or /preview)
//   none      nothing to show inline: Download / Open only

const TEXT_EXT = new Set([
  'txt', 'log', 'ini', 'cfg', 'conf', 'toml', 'yaml', 'yml', 'xml', 'py', 'js', 'ts', 'jsx', 'tsx',
  'c', 'h', 'cpp', 'hpp', 'java', 'go', 'rs', 'sh', 'css', 'sql', 'kt', 'swift', 'rb', 'php',
])
const PREVIEW_EXT = new Set(['docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'odt', 'ods', 'odp', 'rtf'])

const LABEL = {
  image: 'image', video: 'video', audio: 'audio', pdf: 'PDF', html: 'HTML', markdown: 'markdown',
  csv: 'table', json: 'JSON', text: 'text', none: 'file',
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

/** file { mime, filename, kind } → { viewer, label } */
export function viewerFor(file) {
  const mime = String(file.mime || file.content_type || '').split(';')[0].trim().toLowerCase()
  const ext = extOf(file.filename)
  const kind = file.kind || ''
  let viewer = 'none'
  if (mime.startsWith('image/') || kind === 'image') viewer = 'image'
  else if (mime.startsWith('video/') || kind === 'video') viewer = 'video'
  else if (mime.startsWith('audio/') || kind === 'audio') viewer = 'audio'
  else if (mime === 'application/pdf' || ext === 'pdf') viewer = 'pdf'
  else if (mime === 'text/html' || mime === 'application/xhtml+xml' || ext === 'html' || ext === 'htm') viewer = 'html'
  else if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') viewer = 'markdown'
  else if (mime === 'text/csv' || mime === 'text/tab-separated-values' || ext === 'csv' || ext === 'tsv') viewer = 'csv'
  else if (mime === 'application/json' || ext === 'json') viewer = 'json'
  else if (PREVIEW_EXT.has(ext) || mime.includes('officedocument') || mime.includes('opendocument')
           || mime === 'application/msword' || mime === 'application/vnd.ms-excel') viewer = 'preview'
  else if (mime.startsWith('text/') || TEXT_EXT.has(ext)) viewer = 'text'
  const label = viewer === 'preview' ? (ext ? ext.toUpperCase() : 'document') : LABEL[viewer]
  return { viewer, label }
}
