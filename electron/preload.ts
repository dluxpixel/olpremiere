// Preload — the ONLY bridge between renderer and main. Emitted as CommonJS
// (out/preload/index.cjs) because a sandboxed preload cannot be an ES module.
// Exposes a minimal, typed `window.api`; no fs, no child_process, no raw
// ipcRenderer leaked to the page.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  NativeCaps,
  NativeExportConfig,
  NativeFinishResult,
  NativeProgress,
  NativeStartResult,
  OlApi,
} from './ipc-types'

const api: OlApi = {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:version'),
  nativeProbe: (): Promise<NativeCaps> => ipcRenderer.invoke('native:probe'),
  nativePrepareAudio: (wav: ArrayBuffer) => ipcRenderer.invoke('native:prepareAudio', wav),
  nativeStart: (config: NativeExportConfig): Promise<NativeStartResult> => ipcRenderer.invoke('native:start', config),
  nativeWriteFrame: (frame: ArrayBuffer) => ipcRenderer.invoke('native:writeFrame', frame),
  nativeFinish: (): Promise<NativeFinishResult> => ipcRenderer.invoke('native:finish'),
  nativeCancel: () => ipcRenderer.invoke('native:cancel'),
  onNativeProgress: (cb: (p: NativeProgress) => void) => {
    const l = (_e: unknown, p: NativeProgress) => cb(p)
    ipcRenderer.on('native:progress', l)
    return () => ipcRenderer.off('native:progress', l)
  },
}

contextBridge.exposeInMainWorld('api', api)
