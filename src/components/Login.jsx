import { useEffect, useRef, useState } from 'react'
import { API_BASE, GOOGLE_CLIENT_ID, PRODUCT_NAME } from '../lib/endpoints.js'

// Two ways in, decided by the server's GET /auth/config:
//   local_login       → email + password (the admin account set at install)
//   google_client_id  → "Sign in with Google" (optional; needs an OAuth client)
// The Google script is only loaded when a client id exists, so installs
// without Google never touch accounts.google.com.

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const GIS_POLL_MS = 100
const GIS_TIMEOUT_MS = 10000

function loadGis() {
  if (window.google?.accounts?.id) return
  if (document.querySelector(`script[src="${GIS_SRC}"]`)) return
  const s = document.createElement('script')
  s.src = GIS_SRC
  s.async = true
  s.defer = true
  document.head.appendChild(s)
}

const unreachable = () => `Can't reach the Nandi server at ${API_BASE}.`

export default function Login({ onLogin }) {
  // loading | ready | error (server unreachable)
  const [phase, setPhase] = useState('loading')
  const [authCfg, setAuthCfg] = useState({ local_login: false, google_client_id: '' })
  const [googleStatus, setGoogleStatus] = useState('off') // off | loading | ready | unavailable
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const buttonRef = useRef(null)

  function acceptToken(data) {
    if (!data?.access_token) {
      setError('Sign-in succeeded but no token was returned.')
      return
    }
    localStorage.setItem('user_token', data.access_token)
    onLogin()
  }

  // ── 1. Ask the server which sign-in methods it offers ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/config`, { signal: AbortSignal.timeout(8000) })
        const data = res.ok ? await res.json().catch(() => ({})) : {}
        if (cancelled) return
        if (!res.ok && res.status !== 404) throw new Error(String(res.status))
        // A 404 means an older brain without /auth/config: Google only.
        setAuthCfg({
          local_login: !!data.local_login,
          google_client_id: data.google_client_id || GOOGLE_CLIENT_ID || '',
        })
        setPhase('ready')
      } catch (err) {
        if (cancelled) return
        console.error('[login] /auth/config failed:', err)
        setError(unreachable())
        setPhase('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const clientId = authCfg.google_client_id || GOOGLE_CLIENT_ID

  // ── 2. Google button (only when a client id exists) ──
  useEffect(() => {
    if (phase !== 'ready' || !clientId) return
    let cancelled = false
    let timer = null
    const startedAt = Date.now()
    setGoogleStatus('loading')
    loadGis()

    async function handleCredential(response) {
      setError('')
      try {
        const res = await fetch(`${API_BASE}/auth/google-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(
            res.status === 403
              ? 'That Google account is not on the access list.'
              : data.detail || `Sign-in failed (${res.status}).`
          )
          return
        }
        acceptToken(data)
      } catch (err) {
        console.error('[login] google request failed:', err)
        setError(unreachable())
      }
    }

    // GIS loads async, so poll until it is ready instead of checking once.
    function tryInit() {
      if (cancelled) return
      if (!window.google?.accounts?.id) {
        if (Date.now() - startedAt > GIS_TIMEOUT_MS) {
          setGoogleStatus('unavailable')
          return
        }
        timer = setTimeout(tryInit, GIS_POLL_MS)
        return
      }
      try {
        window.google.accounts.id.initialize({ client_id: clientId, callback: handleCredential })
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
        })
        setGoogleStatus('ready')
      } catch (err) {
        console.error('[login] GIS init failed:', err)
        setGoogleStatus('unavailable')
      }
    }

    tryInit()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, clientId])

  // ── 3. Email + password ──
  async function handleLocalSubmit(e) {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(
          res.status === 401
            ? 'Wrong email or password.'
            : res.status === 403
              ? 'That account is not allowed to sign in.'
              : res.status === 429
                ? 'Too many attempts. Wait a minute and try again.'
                : data.detail || `Sign-in failed (${res.status}).`
        )
        return
      }
      acceptToken(data)
    } catch (err) {
      console.error('[login] local request failed:', err)
      setError(unreachable())
    } finally {
      setBusy(false)
    }
  }

  const noMethods = phase === 'ready' && !authCfg.local_login && !clientId

  return (
    <div className="login-page">
      <img src="/logo.png" alt={PRODUCT_NAME} className="login-page__logo" />
      <h1 className="login-page__title">{PRODUCT_NAME.toUpperCase()}</h1>
      <p className="login-page__subtitle">Your Personal AI Assistant</p>

      {phase === 'loading' && <p className="login-page__hint">Connecting…</p>}

      {phase === 'ready' && authCfg.local_login && (
        <form className="login-form" onSubmit={handleLocalSubmit}>
          <input
            className="login-form__input"
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="login-form__input"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="login-form__submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {phase === 'ready' && authCfg.local_login && clientId && (
        <div className="login-form__divider"><span>or</span></div>
      )}

      {phase === 'ready' && clientId && (
        <div className="login-page__btn-wrap" ref={buttonRef} id="g-signin-btn" />
      )}

      {googleStatus === 'loading' && !authCfg.local_login && (
        <p className="login-page__hint">Loading sign-in…</p>
      )}
      {googleStatus === 'unavailable' && (
        <p className="login-page__hint login-page__hint--error">
          Google sign-in could not load. Check your connection or any content
          blocker, then reload the page.
        </p>
      )}

      {noMethods && (
        <p className="login-page__hint login-page__hint--error">
          No sign-in method is configured on this server. Set NANDI_ADMIN_EMAIL and
          NANDI_ADMIN_PASSWORD (or GOOGLE_CLIENT_ID) in .env and restart.
        </p>
      )}

      {error && (
        <p className="login-page__hint login-page__hint--error" role="alert">
          {error}
        </p>
      )}

      {phase === 'error' && (
        <button className="login-form__submit login-form__retry" onClick={() => window.location.reload()}>
          Retry
        </button>
      )}
    </div>
  )
}
