import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Inside Docker Compose the API is reachable as the `backend` service; running
// `npm run dev` directly on a dev machine there is no such host, so DNS fails
// with ENOTFOUND. Compose sets BACKEND_URL explicitly, everything else falls
// back to the locally-running uvicorn.
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/uploads': BACKEND_URL,
      '/auth': BACKEND_URL,
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
})
