// The shared IPC type surface between the Electron main process, the sandboxed
// preload, and the renderer (via electron-api.d.ts).

export type NativeEncoder = 'x264' | 'x265' | 'nvenc-h264' | 'nvenc-hevc' | 'nvenc-av1' | 'prores' | 'lossless'

export interface NativeCaps {
  ok: boolean
  encoders: string[]
  nvenc: { h264: boolean; hevc: boolean; av1: boolean }
}

export interface NativeExportConfig {
  width: number
  height: number
  fps: number
  totalFrames: number
  encoder: NativeEncoder
  /** QP/CRF on the 0–51 scale (used by x264/x265/nvenc; ignored by prores/lossless). */
  quality: number
  hasAudio: boolean
  /** When set, skip the save dialog (used by re-export / tests). */
  outPath?: string
  suggestedName: string
}

export interface NativeStartResult {
  started: boolean
  outPath?: string
  cancelled?: boolean
  error?: string
}

export interface NativeFinishResult {
  ok: boolean
  outPath?: string
  sizeBytes?: number
  error?: string
}

export interface NativeProgress {
  frame: number
  totalFrames: number
}

export interface OlApi {
  /** Always true when running inside the desktop shell — the renderer's isElectron gate. */
  readonly isElectron: true
  getVersion(): Promise<string>
  /** Which native encoders this machine's bundled ffmpeg + GPU actually offer. */
  nativeProbe(): Promise<NativeCaps>
  /** Write the rendered audio mix (a full WAV) to a temp file BEFORE starting (it's an ffmpeg input). */
  nativePrepareAudio(wav: ArrayBuffer): Promise<{ ok: boolean }>
  /** Pick a destination (or use config.outPath) and spawn ffmpeg. */
  nativeStart(config: NativeExportConfig): Promise<NativeStartResult>
  /** Stream one raw RGBA frame to ffmpeg; resolves when it's accepted (backpressure). */
  nativeWriteFrame(frame: ArrayBuffer): Promise<{ ok: boolean; error?: string }>
  /** Close the stream, wait for ffmpeg to finish, return the result. */
  nativeFinish(): Promise<NativeFinishResult>
  /** Abort + clean up a partial file. */
  nativeCancel(): Promise<void>
  /** Encode progress (frame/totalFrames) parsed from ffmpeg. Returns an unsubscribe fn. */
  onNativeProgress(cb: (p: NativeProgress) => void): () => void
  /** Fires when a newer version has downloaded and is staged to install on restart. Returns an unsubscribe fn. */
  onUpdateReady(cb: (version: string) => void): () => void
  /**
   * Fires when an update downloaded during the fresh-launch window and main wants
   * to apply it NOW — but the renderer arbitrates: it flushes a save and restarts
   * only if no critical work (e.g. an export) is in flight, else it defers to the
   * "Restart to update" toast. Returns an unsubscribe fn.
   */
  onAutoApplyUpdate(cb: (version: string) => void): () => void
  /** Fires when an update CHECK or download fails (404 feed, offline, bad yml). Returns an unsubscribe fn. */
  onUpdateError(cb: (message: string) => void): () => void
  /** Fires when the check succeeded and the app is already newest. Returns an unsubscribe fn. */
  onUpdateNone(cb: () => void): () => void
  /** Quit and install the downloaded update now — relaunches into the new version. */
  restartToUpdate(): void

  /** One automatic backup of the project DOCUMENT to a plain file. Returns its path. */
  backupWrite(projectName: string, json: string): Promise<string>
  /** Newest first. */
  backupList(): Promise<BackupEntry[]>
  /** The folder backups live in, for showing the user where their safety net is. */
  backupDir(): Promise<string>
  /** Read one back for restoring. Only paths inside the backup folder are allowed. */
  backupRead(filePath: string): Promise<string>
  /** Open the backup folder in Explorer. */
  backupReveal(): Promise<void>
}

export interface BackupEntry {
  name: string
  path: string
  sizeBytes: number
  modifiedMs: number
}
