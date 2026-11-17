import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Кастомный SW (src/sw.ts) с push-обработчиком: precache-манифест
      // инжектится в self.__WB_MANIFEST. Runtime-caching картинок живёт
      // в sw.ts — опции generateSW (runtimeCaching) здесь не работают.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*'],
      manifest: false, // манифест генерируется per-tenant: public/s/<slug>/manifest.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' }, // dev: фронт + локальный Express
  },
  test: { include: ['tests/core/**/*.test.ts', 'tests/backend/**/*.test.ts'] },
})
