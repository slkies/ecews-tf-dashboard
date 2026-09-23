import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Development only: serve the map boundary files straight from backend/static.
 * The backend serves them at the site root in production; in development that
 * would need Docker running just to draw the map. Public geography, no data.
 */
function boundaryFiles(): Plugin {
  const files = ['nga_lga_3states.geojson', 'nga_context_states.geojson']
  return {
    name: 'boundary-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = files.find((f) => req.url?.split('?')[0] === `/${f}`)
        if (!name) return next()
        res.setHeader('Content-Type', 'application/geo+json')
        res.end(readFileSync(fileURLToPath(new URL(`../backend/static/${name}`, import.meta.url))))
      })
    },
  }
}

// The React app is built into its own directory and served at /app while the
// existing single-file dashboard keeps serving / unchanged. The live dashboard
// is in weekly use by state teams; it does not come down for a rewrite. When
// the React app reaches parity the two swap, and this base becomes '/'.
export default defineConfig({
  // Tailwind v4 runs as a Vite plugin at build time and emits plain CSS, so it
  // adds no runtime request - the no-external-requests rule is untouched.
  plugins: [react(), tailwindcss(), boundaryFiles()],
  // shadcn components import from "@/components/ui/...". One alias, mirrored
  // in tsconfig.json so the editor and the bundler agree.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
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
      // The self-hosted fonts and the logo are served by the app, not by this
      // build, so the dev server borrows them - otherwise every page in
      // development renders in a fallback face and a missing logo.
      '/vendor': { target: 'http://localhost:8080', changeOrigin: true },
      '/brand': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
