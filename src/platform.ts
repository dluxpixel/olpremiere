// The one place the renderer learns whether it's running inside the Electron
// desktop shell. On the web build `window.api` is undefined, `isElectron` is
// false, and every native-only branch is dead code that never runs.

export const olApi = typeof window !== 'undefined' ? window.api : undefined
export const isElectron = !!olApi?.isElectron
