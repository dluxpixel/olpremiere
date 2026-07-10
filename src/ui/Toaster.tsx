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
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          className={`pointer-events-auto flex items-center gap-3 rounded-[6px] border bg-bg-elevated px-3 py-2 text-[12px] text-text-primary shadow-pop ${kindClasses[t.kind]}`}
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
              className="shrink-0 rounded-[4px] bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-accent-hover"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
