import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app version, read from package.json at config time and injected into the
// bundle. One source of truth for the version the UI shows + the update check.
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/** Every file under public/, as the URL paths the page will ask for. */
function publicFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? publicFiles(full, root) : ['/' + relative(root, full).replaceAll('\\', '/')]
  })
}

/**
 * THE EDITOR OPENS WITH NO SIGNAL (2026-09-23, the phone). He edits on the bus,
 * where the signal comes and goes, so the web build ships a service worker
 * (src/sw.template.js) that keeps a copy of EVERY file the app can ask for: the
 * page, each code chunk including the ones only export and captions load, the
 * fonts and the sound effects. The list is written here at build time from the
 * real bundle, so nothing is guessed and a new build is a new list, which is
 * also how the phone learns there is an update.
 *
 * Web build only. The desktop app is built by electron.vite.config.ts, loads
 * from app:// and never registers a worker (src/main.tsx).
 */
function offlineCopy(): Plugin {
  return {
    name: 'olp-offline-copy',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = new Set<string>(['/', ...publicFiles('public')])
      for (const name of Object.keys(bundle)) files.add('/' + name)
      const list = [...files].filter((f) => f !== '/sw.js').sort()
      const template = readFileSync(new URL('./src/sw.template.js', import.meta.url), 'utf8')
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace('__OLP_VERSION__', JSON.stringify(`${appVersion}-${Date.now().toString(36)}`))
          .replace('__OLP_FILES__', JSON.stringify(list)),
      })
    },
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), tailwindcss(), offlineCopy()],
  worker: {
    // The transcribe worker dynamic-imports transformers.js (code-splitting),
    // which the default iife worker format cannot express. Every supported
    // browser (WebCodecs-class) runs module workers.
    format: 'es',
  },
})
