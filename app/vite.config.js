import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// No `base` needed — deployed at root via CNAME (app.laviolette.io).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
})
