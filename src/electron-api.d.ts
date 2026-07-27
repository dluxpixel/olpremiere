// Types `window.api`, the desktop bridge exposed by the Electron preload. It is
// `undefined` on the web build (see src/platform.ts isElectron gate).
import type { OlApi } from '../electron/ipc-types'

declare global {
  interface Window {
    api?: OlApi
  }
  /**
   * The app version, injected at build time (Vite `define`) from package.json.
   * Baked into the renderer bundle, so after an auto-update it reflects the NEW
   * version: the single source of truth for "which build am I on".
   */
  const __APP_VERSION__: string
}

export {}
