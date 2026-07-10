import { create } from 'zustand'

/** An optional inline button on a toast — e.g. "Undo" on a destructive action. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'danger'
  action?: ToastAction
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, kind?: Toast['kind'], action?: ToastAction) => void
  dismiss: (id: number) => void
}

let nextId = 1
const TOAST_MS = 3500
// A toast carrying an action lingers longer: the user needs time to reach it.
const TOAST_ACTION_MS = 7000

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, kind = 'info', action) {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, kind, ...(action ? { action } : {}) }] }))
    window.setTimeout(() => get().dismiss(id), action ? TOAST_ACTION_MS : TOAST_MS)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
