// Preload: the ONLY bridge between renderer and main. Emitted as CommonJS
// (out/preload/index.cjs) because a sandboxed preload cannot be an ES module.
// Exposes a minimal, typed `window.api`; no fs, no child_process, no raw
// ipcRenderer leaked to the page.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  NativeCaps,
  NativeExportConfig,
  NativeFinishResult,
  NativeProgress,
  BootProgress,
  NativeStartResult,
  OlApi,
  UpdateStatus,
} from './ipc-types'

const api: OlApi = {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Real machine memory, because navigator.deviceMemory is capped at 8 GB by the
  // spec and reports TOTAL rather than free. See engine/memoryBudget.ts.
  systemMemory: (): Promise<{ totalKb: number; freeKb: number }> => ipcRenderer.invoke('system:memory'),
  nativeProbe: (): Promise<NativeCaps> => ipcRenderer.invoke('native:probe'),
  nativePrepareAudio: (wav: ArrayBuffer) => ipcRenderer.invoke('native:prepareAudio', wav),
  nativeStart: (config: NativeExportConfig): Promise<NativeStartResult> => ipcRenderer.invoke('native:start', config),
  nativeWriteFrame: (frame: ArrayBuffer) => ipcRenderer.invoke('native:writeFrame', frame),
  nativeFinish: (): Promise<NativeFinishResult> => ipcRenderer.invoke('native:finish'),
  nativeCancel: () => ipcRenderer.invoke('native:cancel'),
  mediaList: () => ipcRenderer.invoke('media:list'),
  mediaBegin: (id: string) => ipcRenderer.invoke('media:begin', id),
  mediaChunk: (id: string, bytes: ArrayBuffer) => ipcRenderer.invoke('media:chunk', id, bytes),
  mediaFinish: (id: string) => ipcRenderer.invoke('media:finish', id),
  mediaCancel: (id: string) => ipcRenderer.invoke('media:cancel', id),
  mediaRead: (id: string, offset: number, length: number) => ipcRenderer.invoke('media:read', id, offset, length),
  mediaDelete: (id: string) => ipcRenderer.invoke('media:delete', id),
  proxyBegin: () => ipcRenderer.invoke('proxy:begin'),
  proxyChunk: (id: string, bytes: ArrayBuffer) => ipcRenderer.invoke('proxy:chunk', id, bytes),
  proxyFinish: (id: string) => ipcRenderer.invoke('proxy:finish', id),
  proxyRead: (id: string, offset: number, length: number) => ipcRenderer.invoke('proxy:read', id, offset, length),
  proxyRelease: (id: string) => ipcRenderer.invoke('proxy:release', id),
  remuxBegin: () => ipcRenderer.invoke('remux:begin'),
  remuxChunk: (id: string, bytes: ArrayBuffer) => ipcRenderer.invoke('remux:chunk', id, bytes),
  remuxFinish: (id: string) => ipcRenderer.invoke('remux:finish', id),
  remuxRead: (id: string, offset: number, length: number) => ipcRenderer.invoke('remux:read', id, offset, length),
  remuxRelease: (id: string) => ipcRenderer.invoke('remux:release', id),
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
  setUpdateBusy: (on: boolean) => ipcRenderer.send('update:busy', on),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status:get'),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
  reportBootProgress: (progress: BootProgress) => ipcRenderer.send('boot:progress', progress),
  bootFinished: () => ipcRenderer.send('boot:finished'),
  onBootProgress: (cb: (progress: BootProgress) => void) => {
    const l = (_e: unknown, progress: BootProgress) => cb(progress)
    ipcRenderer.on('boot:progress', l)
    return () => ipcRenderer.off('boot:progress', l)
  },
  onBootReady: (cb: () => void) => {
    const l = () => cb()
    ipcRenderer.on('boot:ready', l)
    return () => ipcRenderer.off('boot:ready', l)
  },
  splashShrink: () => ipcRenderer.send('boot:shrink'),
  splashEnter: () => ipcRenderer.send('boot:enter'),
  updateShow: () => ipcRenderer.send('update:show'),
  updateShrink: () => ipcRenderer.send('update:shrink'),
  updateApply: () => ipcRenderer.send('update:apply'),
  updateDismiss: () => ipcRenderer.send('update:dismiss'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const l = (_e: unknown, status: UpdateStatus) => cb(status)
    ipcRenderer.on('update:status', l)
    return () => ipcRenderer.off('update:status', l)
  },
  // Backups: the renderer decides WHAT to save, main decides WHERE. The renderer
  // never learns a filesystem path it could write to on its own.
  backupWrite: (projectName: string, json: string) => ipcRenderer.invoke('backup:write', projectName, json),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupDir: () => ipcRenderer.invoke('backup:dir'),
  backupRead: (filePath: string) => ipcRenderer.invoke('backup:read', filePath),
  backupReveal: () => ipcRenderer.invoke('backup:reveal'),
}

contextBridge.exposeInMainWorld('api', api)
