// electron-vite config for the desktop build. The renderer section reuses the
// EXISTING root index.html + src/ (root:'.') with the same plugins and ES module
// workers as vite.config.ts, so the web renderer code is untouched. The web
// build keeps using vite.config.ts → dist/; this config outputs to out/.

import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Same version injection as the web build (vite.config.ts): the renderer reads
// __APP_VERSION__ from package.json. After an auto-update the new bundle carries
// the new number, so the version the UI shows is always the running build.
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  main: {
    // Bundle electron-updater INTO main.js (exclude from externalization) so the
    // packaged asar needs no node_modules — the app ships lean (out/** only).
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // The './' prefix is load-bearing: a bare 'electron/main.ts' reads as the
        // `electron` package's subpath and externalizeDepsPlugin marks it external.
        input: './electron/main.ts',
        output: { entryFileNames: 'main.js', format: 'es' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: './electron/preload.ts',
        // Sandboxed preload MUST be CommonJS; under "type":"module" a .js is ESM,
        // so emit .cjs explicitly.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    // Keep the renderer exactly where it lives — root index.html + src/.
    root: '.',
    base: '/', // absolute asset URLs, served by the app:// protocol handler
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' }, // module workers, matching vite.config.ts
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: 'index.html' },
    },
  },
})
