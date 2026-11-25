import React, { useState, useEffect, useCallback } from 'react'
import Login from './components/Login.jsx'
import DeviceSetup from './components/DeviceSetup.jsx'
import ChatView from './components/ChatView.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import { getDeviceName } from './lib/clientId.js'
import { disconnect, resetConnection } from './lib/wsAdapter.js'
import { disconnect as disconnectVisionControl } from './lib/visionControl.js'

function getDeviceId() {
  // Shared with clientId.js, which derives the client_id both sockets send.
  const name = getDeviceName()
  return name === 'unknown' ? null : name
}

function setDeviceIdCookie(id) {
  // Set cookie that lasts 10 years
  const expires = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString()
  document.cookie = `nandi_device_id=${encodeURIComponent(id)};expires=${expires};path=/;SameSite=Lax`
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [deviceId, setDeviceId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check existing auth + device on mount
    const token = localStorage.getItem('user_token')
    const savedDevice = getDeviceId()
    if (token) setIsLoggedIn(true)
    if (savedDevice) setDeviceId(savedDevice)
    setLoading(false)
  }, [])

  const handleLogin = useCallback(() => {
    // Clear the "stop reconnecting" flag set by a previous auth failure,
    // otherwise the socket stays permanently down after re-login.
    resetConnection()
    setIsLoggedIn(true)
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem('user_token')
    disconnect()
    // The vision-control socket registered with the same token. Left open it
    // would keep receiving this account's frames after sign-out; the next
    // login's vision hook (useVisionBoxes) starts it afresh.
    disconnectVisionControl()
    // Same token again: the phones' approvals must not keep arriving after sign-out.
    setIsLoggedIn(false)
  }, [])

  const handleDeviceSet = useCallback((name) => {
    setDeviceIdCookie(name)
    setDeviceId(name)
  }, [])

  if (loading) return null

  // Step 1: Login · Step 2: device setup (only if no device cookie) · Step 3: main chat view
  const view = !isLoggedIn ? <Login onLogin={handleLogin} />
    : !deviceId ? <DeviceSetup onDeviceSet={handleDeviceSet} />
    : <ChatView deviceId={deviceId} onLogout={handleLogout} />

  return (
    <>
      <UpdateBanner />
      {view}
    </>
  )
}
