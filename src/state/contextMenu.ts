import { create } from 'zustand'

export interface MenuItem {
  label: string
  /** Optional when `submenu` is present (the row just opens the flyout). */
  onClick?: () => void
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Render a divider ABOVE this item. */
  separator?: boolean
  /** A checkmark/active dot before the label (e.g. the selected preset). */
  checked?: boolean
  /** One level of nested items, shown as a hover flyout to the side. */
  submenu?: MenuItem[]
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  show: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

/** App-wide custom context menu (replaces the browser menu). */
export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false, items: [] }),
}))

/** Convenience for onContextMenu handlers: prevent the browser menu + open ours. */
export function openContextMenu(e: { preventDefault: () => void; clientX: number; clientY: number }, items: MenuItem[]): void {
  if (items.length === 0) return
  e.preventDefault()
  useContextMenu.getState().show(e.clientX, e.clientY, items)
}
