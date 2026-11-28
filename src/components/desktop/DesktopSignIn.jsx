import React, { useState } from 'react'
import { desktop } from '../../lib/desktop.js'
import './desktop.css'

/**
 * Sign-in inside the desktop app. Google doesn't allow signing in inside an
 * embedded browser, so the button opens this web app in the system browser
 * (?desktop_login=…), where Login signs in as usual and hands the token back
 * to the app on 127.0.0.1. The app then reloads this page, signed in.
 */
export default function DesktopSignIn() {
  const [state, setState] = useState('idle')      // idle | waiting
  const [error, setError] = useState('')

  const start = async () => {
    setError('')
    setState('waiting')
    const r = await desktop.login().catch(err => ({ ok: false, error: err?.message }))
    if (!r?.ok) {
      setState('idle')
      if (r?.error) setError(r.error)
    }
  }

  const cancel = () => {
    desktop.cancelLogin()
    setState('idle')
  }

  return (
    <div className="login-page">
      <img src="/logo.png" alt="Nandi AI" className="login-page__logo" />
      <h1 className="login-page__title">NANDI AI</h1>
      <p className="login-page__subtitle">Your Personal AI Assistant</p>

      {state === 'idle' ? (
        <button className="desktop-signin__btn" onClick={start}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Sign in with Google
        </button>
      ) : (
        <>
          <p className="login-page__hint">Finish signing in in your browser, then come back here.</p>
          <button className="desktop-signin__link" onClick={cancel}>Cancel</button>
        </>
      )}
      <p className="login-page__hint desktop-signin__note">Opens your web browser: Google only signs in there.</p>
      {error && <p className="login-page__hint login-page__hint--error" role="alert">{error}</p>}
    </div>
  )
}
