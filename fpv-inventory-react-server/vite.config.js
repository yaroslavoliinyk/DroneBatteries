import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    watch: {
      usePolling: true,
      interval: 800,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    },
    hmr: {
      clientPort: 3000,
    },
  },
})
