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
}

/** Optional display tuning for a toast. */
export interface ToastOptions {
  /** Override how long the toast stays up (ms). Used for the prominent update banner. */
  durationMs?: number
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, kind?: Toast['kind'], action?: ToastAction, opts?: ToastOptions) => void
  dismiss: (id: number) => void
  /** The pointer is on the toast: its clock stops, so it cannot vanish as he reaches for it. */
  hold: (id: number) => void
  /** The pointer left: the clock runs again with the time that was left. */
  release: (id: number) => void
}

let nextId = 1
const TOAST_MS = 3500
// A toast carrying an action lingers longer: the user needs time to reach it.
const TOAST_ACTION_MS = 7000

/** Each toast's clock. `timer` is null while the pointer holds it, and `left` is what remains. */
interface Clock {
  timer: ReturnType<typeof setTimeout> | null
  dueAt: number
  left: number
}
const clocks = new Map<number, Clock>()

function stopClock(id: number): void {
  const c = clocks.get(id)
  if (c?.timer) clearTimeout(c.timer)
  clocks.delete(id)
}

/** Start (or restart) a toast's clock. A held toast stays held, with the full time waiting. */
function runClock(id: number, ms: number): void {
  const held = clocks.get(id)?.timer === null
  stopClock(id)
  if (held) {
    clocks.set(id, { timer: null, dueAt: 0, left: ms })
    return
  }
  const timer = setTimeout(() => useToasts.getState().dismiss(id), ms)
  clocks.set(id, { timer, dueAt: Date.now() + ms, left: ms })
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, kind = 'info', action, opts) {
    const ms = opts?.durationMs ?? (action ? TOAST_ACTION_MS : TOAST_MS)
    // ⛔ THE SAME WORDS AGAIN ARE NOT A SECOND TOAST (2026-10-07). Three presses that said the
    // same thing left three copies stacked over the timeline. One already up with the same
    // message and kind, and no button, stays where it is and its clock starts over.
    const same = action ? undefined : get().toasts.find((t) => !t.action && t.message === message && t.kind === kind)
    if (same) {
      runClock(same.id, ms)
      return
    }
    const id = nextId++
    set((s) => {
      // Cap the stack: a bad folder import (one toast per file) must never
      // wall the screen. Drop the oldest actionless toast past 5.
      let toasts = s.toasts
      if (toasts.length >= 5) {
        const drop = toasts.find((t) => !t.action)
        toasts = drop ? toasts.filter((t) => t !== drop) : toasts.slice(1)
      }
      return { toasts: [...toasts, { id, message, kind, ...(action ? { action } : {}) }] }
    })
    runClock(id, ms)
  },
  dismiss(id) {
    stopClock(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  hold(id) {
    const c = clocks.get(id)
    if (!c?.timer) return
    clearTimeout(c.timer)
    clocks.set(id, { timer: null, dueAt: 0, left: Math.max(0, c.dueAt - Date.now()) })
  },
  release(id) {
    const c = clocks.get(id)
    if (!c || c.timer) return
    clocks.delete(id)
    runClock(id, c.left)
  },
}))
