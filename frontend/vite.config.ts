import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The React app is built into its own directory and served at /app while the
// existing single-file dashboard keeps serving / unchanged. The live dashboard
// is in weekly use by state teams; it does not come down for a rewrite. When
// the React app reaches parity the two swap, and this base becomes '/'.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: '../backend/static_app',
    emptyOutDir: true,
    // The institutional firewall is the reason the current page self-hosts
    // Chart.js and its fonts and makes no external request at runtime. That
    // property has to survive the rewrite, so everything is bundled from
    // node_modules into our own origin - no CDN, no Google Fonts, ever.
    assetsInlineLimit: 4096,
    sourcemap: true,
  },
  server: {
    // `npm run dev` talks to the real API in Docker, so the dev server shows
    // real data rather than fixtures.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
