import { useToasts, type Toast } from '../state/toasts'

const kindClasses: Record<Toast['kind'], string> = {
  info: 'border-border',
  success: 'border-success/40',
  danger: 'border-danger/40',
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    // Bottom-RIGHT, not bottom-center: centered toasts sat directly on top of
    // the timeline clips being edited. Newest at the bottom, stack grows up.
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col items-end gap-2"
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
