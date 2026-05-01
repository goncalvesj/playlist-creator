import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSW } from 'workbox-build'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rootDir = dirname(fileURLToPath(import.meta.url))

function workboxServiceWorker(): Plugin {
  return {
    name: 'playlist-creator-workbox-service-worker',
    apply: 'build',
    async closeBundle() {
      const distDir = resolve(rootDir, 'dist')
      const { count, size, warnings } = await generateSW({
        globDirectory: distDir,
        globPatterns: ['**/*.{css,html,js,png,svg,webmanifest}'],
        globIgnores: ['**/*.map'],
        swDest: resolve(distDir, 'sw.js'),
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/\.auth\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        sourcemap: false,
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) =>
              sameOrigin && (url.pathname.startsWith('/icons/') || url.pathname === '/favicon.svg'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'playlist-creator-static-images',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
        ],
      })

      for (const warning of warnings) {
        console.warn(`Workbox warning: ${warning}`)
      }

      console.log(`Generated service worker with ${count} precached files (${size} bytes).`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), workboxServiceWorker()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
