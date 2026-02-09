import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite builds into ../public/app so the kiln can deploy via `git pull` + restart
// without running any Node build steps on the device.
export default defineConfig({
  // The Bottle server serves this UI under /app.
  base: '/app/',
  plugins: [react()],
  server: {
    // HMR dev server. Use proxy so the browser can still connect to legacy WS/HTTP endpoints
    // (our WS client uses window.location.host).
    open: '/app/',
    proxy: {
      '/status': { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
      '/control': { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
      '/storage': { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
      '/config': { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      // Additive REST endpoints for the modern UI.
      '/v1': { target: 'http://localhost:8080', changeOrigin: true },
      '/picoreflow': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
})
