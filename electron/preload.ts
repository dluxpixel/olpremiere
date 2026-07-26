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
  onUpdateReady: (cb: (version: string) => void) => {
    const l = (_e: unknown, version: string) => cb(version)
    ipcRenderer.on('update:ready', l)
    return () => ipcRenderer.off('update:ready', l)
  },
  onAutoApplyUpdate: (cb: (version: string) => void) => {
    const l = (_e: unknown, version: string) => cb(version)
    ipcRenderer.on('update:autoApply', l)
    return () => ipcRenderer.off('update:autoApply', l)
  },
  onUpdateError: (cb: (message: string) => void) => {
    const l = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on('update:error', l)
    return () => ipcRenderer.off('update:error', l)
  },
  onUpdateNone: (cb: () => void) => {
    const l = () => cb()
    ipcRenderer.on('update:none', l)
    return () => ipcRenderer.off('update:none', l)
  },
  restartToUpdate: () => ipcRenderer.send('update:install'),
  // Backups: the renderer decides WHAT to save, main decides WHERE. The renderer
  // never learns a filesystem path it could write to on its own.
  backupWrite: (projectName: string, json: string) => ipcRenderer.invoke('backup:write', projectName, json),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupDir: () => ipcRenderer.invoke('backup:dir'),
  backupRead: (filePath: string) => ipcRenderer.invoke('backup:read', filePath),
  backupReveal: () => ipcRenderer.invoke('backup:reveal'),
}

contextBridge.exposeInMainWorld('api', api)
