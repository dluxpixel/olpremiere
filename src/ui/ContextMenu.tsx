import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu, type MenuItem } from '../state/contextMenu'

// ⛔ THE CLIP MENU IS 791PX TALL (24 rows) AND A 720PX WINDOW IS 720 (2026-10-03). Its last
// row, Delete, ran off the bottom where nothing can reach it. Two things fix it, and
// neither is enough alone. On a window under 820px tall every row gives up 2px of padding
// above and below, which brings that menu to 695px so it fits whole. And the menu now
// scrolls inside the window (see ContextMenu below), which is what the longer variants
// need: a clip with a gap before it adds rows. Measured, not guessed.
const rowClass = (item: MenuItem): string =>
  `flex w-full items-center justify-between gap-6 px-3 py-1.5 [@media(max-height:820px)]:py-1 text-left text-ui transition-colors duration-[120ms] disabled:opacity-40 ${
    item.danger
      ? 'text-danger hover:bg-danger/15'
      : 'text-text-primary hover:bg-accent-quiet hover:text-accent'
  }`

/** Leading area: a checkmark for the active item, else a blank gutter. */
function Check({ on }: { on?: boolean }) {
  return <span className="w-3 shrink-0 text-ui-sm text-accent">{on ? '✓' : ''}</span>
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
  const rowRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [subAt, setSubAt] = useState<{ top: number; left: number } | null>(null)

  // ⛔ THE FLYOUT IS `fixed`, PLACED BY HAND, BECAUSE ITS PARENT NOW SCROLLS. An absolute
  // child of a scroller is cut off by it, so a flyout that opened to the side of a menu
  // taller than the window would have been sliced away at the menu's edge. It sits against
  // its row (or on the other side when the menu is in the right half of the screen) and is
  // clamped vertically: near the bottom edge a tall submenu would otherwise run off-screen
  // (unreachable items). Measured once per open, before paint.
  useLayoutEffect(() => {
    const row = rowRef.current
    const sub = subRef.current
    if (!hasSub || openSub !== index || !row || !sub) {
      setSubAt(null)
      return
    }
    const r = row.getBoundingClientRect()
    const left = flipLeft ? r.left - sub.offsetWidth - 2 : r.right + 2
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 8 - sub.offsetHeight))
    setSubAt({ top, left })
  }, [hasSub, openSub, index, flipLeft])

  return (
    <div
      ref={rowRef}
      className="relative"
      // Entering any row decides which flyout is open: a parent opens its own,
      // any leaf closes whatever was open. No close-on-leave, so crossing into
      // the flyout (2px from its row) never flickers it shut.
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
          <span className="text-ui-sm text-text-muted">▸</span>
        ) : (
          item.shortcut && <span className="text-ui-sm text-text-muted">{item.shortcut}</span>
        )}
      </button>

      {hasSub && openSub === index && (
        <div
          ref={subRef}
          role="menu"
          className="fixed z-10 min-w-[180px] max-h-[70vh] overflow-y-auto rounded-overlay border border-border bg-bg-elevated py-1 shadow-pop"
          style={subAt ?? { top: 0, left: 0, visibility: 'hidden' }}
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
                {sub.shortcut && <span className="text-ui-sm text-text-muted">{sub.shortcut}</span>}
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
    // Scroll closes the menu (it is anchored to a point that just moved),
    // EXCEPT for the scroll the opening click itself causes. A menu opened by
    // LEFT-click from a button inside a scrollable column (the track preset
    // bookmark, auto-level, audio role) focuses that button, the browser
    // scrolls it into view, and the capture-phase listener below fired ~8ms
    // after open and shut the menu again before it could be used. Right-click
    // menus never hit this because nothing takes focus.
    const openedAt = performance.now()
    const onScroll = (e: Event) => {
      if (performance.now() - openedAt < 250) return
      // The menu scrolls itself when it is taller than the window, and a flyout can
      // scroll too: using the menu is not the page moving under it. Only the menu's own
      // scroll shuts the flyouts, because they were placed against rows that just moved.
      if (e.target instanceof Node && ref.current?.contains(e.target)) {
        if (e.target === ref.current) setOpenSub(null)
        return
      }
      close()
    }
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
        data-esc-owner=""
        className="absolute max-h-[calc(100vh-16px)] min-w-[184px] overflow-y-auto rounded-overlay border border-border bg-bg-elevated py-1 shadow-pop"
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
