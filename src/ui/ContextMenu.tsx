import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu, type MenuItem } from '../state/contextMenu'

const rowClass = (item: MenuItem): string =>
  `flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] transition-colors duration-[120ms] disabled:opacity-40 ${
    item.danger
      ? 'text-danger hover:bg-danger/15'
      : 'text-text-primary hover:bg-accent-quiet hover:text-accent'
  }`

/** Leading area: a checkmark for the active item, else a blank gutter. */
function Check({ on }: { on?: boolean }) {
  return <span className="w-3 shrink-0 text-[11px] text-accent">{on ? '✓' : ''}</span>
}

/** A single row; owns its own flyout open state via hover. */
function Row({
  item,
  index,
  openSub,
  setOpenSub,
  flipLeft,
  onLeaf,
}: {
  item: MenuItem
  index: number
  openSub: number | null
  setOpenSub: (i: number | null) => void
  flipLeft: boolean
  onLeaf: () => void
}) {
  const hasSub = !!item.submenu && item.submenu.length > 0
  return (
    <div
      className="relative"
      // Entering any row decides which flyout is open: a parent opens its own,
      // any leaf closes whatever was open. No close-on-leave, so crossing into
      // the flyout (rendered at left/right:100%, no gap) never flickers it shut.
      onMouseEnter={() => setOpenSub(hasSub ? index : null)}
    >
      <button
        role="menuitem"
        aria-haspopup={hasSub || undefined}
        aria-expanded={hasSub ? openSub === index : undefined}
        disabled={item.disabled}
        className={rowClass(item)}
        onClick={() => {
          if (hasSub) {
            setOpenSub(openSub === index ? null : index)
            return
          }
          onLeaf()
          item.onClick?.()
        }}
      >
        <span className="flex items-center gap-1.5">
          <Check on={item.checked} />
          <span>{item.label}</span>
        </span>
        {hasSub ? (
          <span className="text-[11px] text-text-muted">▸</span>
        ) : (
          item.shortcut && <span className="text-[11px] text-text-muted">{item.shortcut}</span>
        )}
      </button>

      {hasSub && openSub === index && (
        <div
          role="menu"
          className="absolute top-0 z-10 min-w-[180px] max-h-[70vh] overflow-y-auto rounded-[6px] border border-border bg-bg-elevated py-1 shadow-pop"
          style={flipLeft ? { right: '100%', marginRight: 2 } : { left: '100%', marginLeft: 2 }}
        >
          {item.submenu!.map((sub, j) => (
            <div key={j}>
              {sub.separator && <div className="my-1 h-px bg-border" />}
              <button
                role="menuitem"
                disabled={sub.disabled}
                className={rowClass(sub)}
                onClick={() => {
                  onLeaf()
                  sub.onClick?.()
                }}
              >
                <span className="flex items-center gap-1.5">
                  <Check on={sub.checked} />
                  <span>{sub.label}</span>
                </span>
                {sub.shortcut && <span className="text-[11px] text-text-muted">{sub.shortcut}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The single app context menu. Renders at the cursor, clamped to the viewport. */
export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    setOpenSub(null)
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

  // Open flyouts to the left when the menu sits in the right half of the screen.
  const flipLeft = pos.x > window.innerWidth * 0.6

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
            <Row
              item={item}
              index={i}
              openSub={openSub}
              setOpenSub={setOpenSub}
              flipLeft={flipLeft}
              onLeaf={close}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
