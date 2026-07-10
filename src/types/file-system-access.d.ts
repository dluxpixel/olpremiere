// File System Access API surface we actually use. TypeScript's lib.dom ships
// FileSystemFileHandle and FileSystemWritableFileStream, but not the picker
// entry points, which are still not in the DOM spec proper.
//
// Declared here rather than cast at each call site so `canStreamToDisk()` is
// the ONLY place that decides whether the API exists (spec §3: branch on real
// capability, never on the user agent).

interface SaveFilePickerType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: SaveFilePickerType[]
  excludeAcceptAllOption?: boolean
}

declare function showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>

interface Window {
  showSaveFilePicker?: typeof showSaveFilePicker
}

// `globalThis` is what engine code touches, so it must carry it too: the export
// controller runs in a window today but must not assume one.
declare namespace globalThis {
  // eslint-disable-next-line no-var
  var showSaveFilePicker: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
}
