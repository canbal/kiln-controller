import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite builds into ../public/app so the kiln can deploy via `git pull` + restart
// without running any Node build steps on the device.
export default defineConfig({
  // The Bottle server serves this UI under /app.
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
})
