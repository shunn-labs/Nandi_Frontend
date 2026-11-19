import { useState } from 'react'

export default function DeviceSetup({ onDeviceSet }) {
  const [name, setName] = useState('')

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onDeviceSet(trimmed)
  }

  return (
    <div className="device-setup">
      <img src="/logo.png" alt="Nandi AI" className="login-page__logo" />
      <h2 className="device-setup__title">Name This Device</h2>
      <p className="device-setup__desc">
        Give this device an identifier so Nandi can recognise it
        across sessions. This is saved locally and only asked once.
      </p>
      <input
        className="device-setup__input"
        placeholder="e.g. home-pc, my-phone, office-tab"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        autoFocus
      />
      <button
        className="device-setup__btn"
        onClick={handleSubmit}
        disabled={!name.trim()}
      >
        Continue
      </button>
    </div>
  )
}
