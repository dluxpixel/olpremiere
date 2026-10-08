// The one line from every place his preferences are written to their file
// (prefsHome.ts). No imports, so store.ts and settings.ts can call it without a
// cycle; prefsHome listens once it has read the file back.

let listener: (() => void) | null = null

/** One of the remembered preferences was just written to localStorage. */
export function notePrefsChanged(): void {
  listener?.()
}

/** prefsHome's ear. Null stops listening. */
export function onPrefsChanged(fn: (() => void) | null): void {
  listener = fn
}
