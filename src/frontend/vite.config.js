import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api and /ws to the FastAPI backend during development so we never
// have to worry about CORS from the browser's perspective.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target:  'ws://localhost:8000',
        ws:      true,
        changeOrigin: true,
      },
    },
  },
})
