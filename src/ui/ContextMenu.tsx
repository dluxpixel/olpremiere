import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu } from '../state/contextMenu'

/** The single app context menu. Renders at the cursor, clamped to the viewport. */
export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!open) return
    setPos({ x, y })
    // Clamp within the viewport once measured.
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - rect.width - 8)
    const ny = Math.min(y, window.innerHeight - rect.height - 8)
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) })
  }, [open, x, y])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[95]" onPointerDown={close} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        role="menu"
        data-testid="context-menu"
        className="absolute min-w-[184px] rounded-[6px] border border-border bg-bg-elevated py-1 shadow-pop"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <div key={i}>
            {item.separator && <div className="my-1 h-px bg-border" />}
            <button
              role="menuitem"
              disabled={item.disabled}
              className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] transition-colors duration-[120ms] disabled:opacity-40 ${
                item.danger
                  ? 'text-danger hover:bg-danger/15'
                  : 'text-text-primary hover:bg-accent-quiet hover:text-accent'
              }`}
              onClick={() => {
                close()
                item.onClick()
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="text-[11px] text-text-muted">{item.shortcut}</span>}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
