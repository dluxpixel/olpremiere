// Types `window.api` — the desktop bridge exposed by the Electron preload. It is
// `undefined` on the web build (see src/platform.ts isElectron gate).
import type { OlApi } from '../electron/ipc-types'

declare global {
  interface Window {
    api?: OlApi
  }
}

export {}
