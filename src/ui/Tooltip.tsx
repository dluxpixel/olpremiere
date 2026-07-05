import type { ReactNode } from 'react'

export interface TooltipProps {
  label: string
  /** Already human-formatted, e.g. "Ctrl+K" — use comboLabel(). */
  shortcut?: string
  side?: 'top' | 'bottom'
  children: ReactNode
}

/**
 * Lightweight CSS-only tooltip. Every toolbar control shows its shortcut here
 * (spec §7). Rendered inline; fine for toolbars, not for viewport edges.
 */
export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  const pos = side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded-[4px] border border-border bg-bg-elevated px-2 py-1 text-[11px] text-text-primary shadow-pop group-hover/tip:block ${pos}`}
      >
        {label}
        {shortcut && <span className="ml-1.5 text-text-muted">{shortcut}</span>}
      </span>
    </span>
  )
}
