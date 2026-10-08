import { create } from 'zustand'

/** An optional inline button on a toast, e.g. "Undo" on a destructive action. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'danger'
  action?: ToastAction
  /** See ToastOptions.replaceKey. */
  replaceKey?: string
}

/** Optional display tuning for a toast. */
export interface ToastOptions {
  /** Override how long the toast stays up (ms). Used for the prominent update banner. */
  durationMs?: number
  /**
   * A toast that says the same kind of thing as one already up REPLACES it
   * rather than stacking under it. Undo and Redo use it: holding Ctrl+Z used to
   * fill the stack with five of them.
   */
  replaceKey?: string
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, kind?: Toast['kind'], action?: ToastAction, opts?: ToastOptions) => void
  dismiss: (id: number) => void
}

let nextId = 1
const TOAST_MS = 3500
// A toast carrying an action lingers longer: the user needs time to reach it.
const TOAST_ACTION_MS = 7000

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, kind = 'info', action, opts) {
    const id = nextId++
    set((s) => {
      // Cap the stack: a bad folder import (one toast per file) must never
      // wall the screen. Drop the oldest actionless toast past 5.
      const key = opts?.replaceKey
      let toasts = key ? s.toasts.filter((t) => t.replaceKey !== key) : s.toasts
      if (toasts.length >= 5) {
        const drop = toasts.find((t) => !t.action)
        toasts = drop ? toasts.filter((t) => t !== drop) : toasts.slice(1)
      }
      return { toasts: [...toasts, { id, message, kind, ...(action ? { action } : {}), ...(key ? { replaceKey: key } : {}) }] }
    })
    const ms = opts?.durationMs ?? (action ? TOAST_ACTION_MS : TOAST_MS)
    window.setTimeout(() => get().dismiss(id), ms)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
