import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app version, read from package.json at config time and injected into the
// bundle. One source of truth for the version the UI shows + the update check.
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), tailwindcss()],
  worker: {
    // The transcribe worker dynamic-imports transformers.js (code-splitting),
    // which the default iife worker format cannot express. Every supported
    // browser (WebCodecs-class) runs module workers.
    format: 'es',
  },
})
