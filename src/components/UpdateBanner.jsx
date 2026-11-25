import React, { useEffect, useState } from 'react'
import { watchForNewBuild } from '../lib/buildCheck.js'

/** "Nandi was updated — Reload" when this page runs an older build than the deployed one. */
export default function UpdateBanner() {
  const [stale, setStale] = useState(false)
  useEffect(() => watchForNewBuild(() => setStale(true)), [])
  if (!stale) return null
  return (
    <div className="update-banner" role="status">
      <span>Nandi was updated. Reload to use the new version.</span>
      <button className="update-banner__btn" onClick={() => location.reload()}>Reload</button>
      <button className="update-banner__close" aria-label="Dismiss" onClick={() => setStale(false)}>×</button>
    </div>
  )
}
