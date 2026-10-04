import { useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu } from '../state/contextMenu'
import { useToasts, type Toast } from '../state/toasts'
import { cornerClasses, toastPlacement, type ToastPlacement } from './toastPlacement'

const kindClasses: Record<Toast['kind'], string> = {
  info: 'border-border',
  success: 'border-success/40',
  danger: 'border-danger/40',
}

const HOME: ToastPlacement = { corner: 'br', covered: false }

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const menuOpen = useContextMenu((s) => s.open)
  const stack = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<ToastPlacement>(HOME)
  const showing = toasts.length > 0

  // ⛔ TOASTS NEVER COVER A MENU (2026-10-03). The stack sits in the bottom right corner at a
  // higher layer than the right-click menu, so a menu opened near that corner lost its last
  // rows to a toast that also took the clicks. While a menu is open the stack moves to the
  // nearest corner the menu is not in (toastPlacement.ts), and it comes home afterwards. Watched
  // every frame while a menu is up, because a flyout opens and moves the menu's edge under it.
  useLayoutEffect(() => {
    if (!menuOpen || !showing) {
      setPlacement((p) => (p === HOME ? p : HOME))
      return
    }
    let raf = 0
    const watch = () => {
      const el = stack.current
      if (el) {
        const box = el.getBoundingClientRect()
        const menus = Array.from(document.querySelectorAll('[role="menu"]')).map((m) => m.getBoundingClientRect())
        const next = toastPlacement({ w: box.width, h: box.height }, menus, window.innerWidth, window.innerHeight)
        setPlacement((p) => (p.corner === next.corner && p.covered === next.covered ? p : next))
      }
      raf = requestAnimationFrame(watch)
    }
    watch()
    return () => cancelAnimationFrame(raf)
  }, [menuOpen, showing])

  if (!showing) return null
  return (
    // Bottom-RIGHT, not bottom-center: centered toasts sat directly on top of
    // the timeline clips being edited. Newest at the bottom, stack grows up.
    <div
      ref={stack}
      data-testid="toast-stack"
      data-corner={placement.corner}
      // No clear corner means the menu has to win, so the stack drops beneath it (z 95).
      className={`pointer-events-none fixed ${placement.covered ? 'z-[90]' : 'z-[100]'} flex flex-col gap-2 ${cornerClasses(placement.corner)}`}
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          className={`pointer-events-auto flex animate-[toast-in_140ms_ease-out] items-center gap-3 rounded-overlay border bg-bg-elevated px-3 py-2 text-ui text-text-primary shadow-pop ${kindClasses[t.kind]}`}
        >
          {/* The message dismisses; a separate action button (e.g. Undo) does not. */}
          <button onClick={() => dismiss(t.id)} className="text-left">
            {t.message}
          </button>
          {t.action && (
            <button
              data-testid="toast-action"
              onClick={() => {
                t.action?.onClick()
                dismiss(t.id)
              }}
              className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-ui-sm font-medium text-accent-fg transition-colors duration-[120ms] hover:bg-accent-hover"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
