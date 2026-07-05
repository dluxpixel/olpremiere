import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'danger'
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, kind?: Toast['kind']) => void
  dismiss: (id: number) => void
}

let nextId = 1
const TOAST_MS = 3500

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, kind = 'info') {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    window.setTimeout(() => get().dismiss(id), TOAST_MS)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
