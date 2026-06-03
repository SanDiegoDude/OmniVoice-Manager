import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build to web/dist (served by FastAPI). In dev, proxy /api to the backend.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8200',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
