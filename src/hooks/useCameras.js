import { useCallback, useEffect, useState } from 'react'
import { getVisionApiBase } from '../lib/endpoints.js'

const REFRESH_MS = 5000

/**
 * The cameras the vision server knows about (GET /api/vision/cameras): each
 * with its stream id, a friendly name and whether it is sending right now.
 * Polled only while `active` (the Devices tab is open).
 *
 * camera: { id, name, type, location, live, owner_client, last_seen_s_ago,
 *           transport: 'hub' | 'jpeg' | 'webrtc' | null, media: { codec, width, height } | null }
 *   transport: how a live camera reaches the server (anything but 'hub' is an old path)
 */
export default function useCameras(active) {
  const [cameras, setCameras] = useState([])
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getVisionApiBase()}/api/vision/cameras`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCameras(Array.isArray(data.cameras) ? data.cameras : [])
      setError(data.registry_error ? String(data.registry_error) : '')
    } catch (err) {
      setError(`Could not reach the vision server (${err.message}).`)
    }
  }, [])

  useEffect(() => {
    if (!active) return undefined
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [active, refresh])

  return { cameras, error, refresh }
}
