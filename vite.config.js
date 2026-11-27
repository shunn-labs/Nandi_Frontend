import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Always 5173: the browser remembers mic/camera permission per origin
    // (scheme + host + PORT). Moving to 5174 when 5173 is busy would be a new
    // site to the browser, and it would ask again. Better to fail loudly.
    strictPort: true,
  },
})
