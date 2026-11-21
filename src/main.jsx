import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import { applyTheme, applyScheme, loadTheme, loadScheme } from './lib/themes.js'

// Before the first render, so the login screen is already in the saved look.
applyTheme(loadTheme())
applyScheme(loadScheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
