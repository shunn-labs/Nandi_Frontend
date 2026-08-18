import { useEffect, useRef, useState } from 'react'
import { getApiBaseUrl } from '../lib/wsAdapter.js'

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '184131206976-5r95aqjt3iqbipahepchl0pj930fpn51.apps.googleusercontent.com'

// index.html loads Google Identity Services with `async defer`, so it is very
// often NOT ready when React mounts. The previous version checked once, logged
// "Google Identity Services not loaded yet", and returned — permanently. The
// button never rendered and there was no other way to sign in, so the whole app
// was unreachable. It looked intermittent (a warm cache usually won the race),
// which is exactly why it survived manual testing.
const GIS_POLL_MS = 100
const GIS_TIMEOUT_MS = 10000

export default function Login({ onLogin }) {
  const [status, setStatus] = useState('loading')   // loading | ready | unavailable
  const [error, setError] = useState('')
  const buttonRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let timer = null
    const startedAt = Date.now()

    async function handleCredential(response) {
      setError('')
      try {
        const base = await getApiBaseUrl()
        const res = await fetch(`${base}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
        })

        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
          // 403 is the whitelist rejecting a valid Google account, which is a
          // different problem from a failed sign-in — say which it is.
          setError(
            res.status === 403
              ? 'That Google account is not on the access list.'
              : data.detail || `Sign-in failed (${res.status}).`
          )
          return
        }

        if (!data.access_token) {
          setError('Sign-in succeeded but no token was returned.')
          return
        }

        localStorage.setItem('user_token', data.access_token)
        onLogin()
      } catch (err) {
        console.error('[login] request failed:', err)
        setError('Could not reach the server. Check your connection and try again.')
      }
    }

    // Poll until GIS has finished loading, then render the button.
    function tryInit() {
      if (cancelled) return

      if (!window.google?.accounts?.id) {
        if (Date.now() - startedAt > GIS_TIMEOUT_MS) {
          setStatus('unavailable')
          return
        }
        timer = setTimeout(tryInit, GIS_POLL_MS)
        return
      }

      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredential,
        })
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
        })
        setStatus('ready')
      } catch (err) {
        console.error('[login] GIS init failed:', err)
        setStatus('unavailable')
      }
    }

    tryInit()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [onLogin])

  return (
    <div className="login-page">
      <img src="/logo.png" alt="Nandi AI" className="login-page__logo" />
      <h1 className="login-page__title">NANDI AI</h1>
      <p className="login-page__subtitle">Your Personal AI Assistant</p>

      <div className="login-page__btn-wrap" ref={buttonRef} id="g-signin-btn" />

      {status === 'loading' && (
        <p className="login-page__hint">Loading sign-in…</p>
      )}

      {status === 'unavailable' && (
        <p className="login-page__hint login-page__hint--error">
          Google sign-in could not load. Check your connection or any content
          blocker, then reload the page.
        </p>
      )}

      {error && (
        <p className="login-page__hint login-page__hint--error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
