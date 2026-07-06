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
        <button
          key={t.id}
          data-testid="toast"
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-[6px] border bg-bg-elevated px-3 py-2 text-[12px] text-text-primary shadow-pop ${kindClasses[t.kind]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
