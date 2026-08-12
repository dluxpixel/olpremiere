import { Bookmark } from 'lucide-react'
import { useState } from 'react'
import { applyTrackPreset, defaultTrackPresetId, listTrackPresets, removeTrackPreset, saveTrackPresetFromCurrent, setDefaultTrackPreset } from '../state/trackTemplate'
import { openContextMenu, type MenuItem } from '../state/contextMenu'

/**
 * Footer bookmark: the shelf of NAMED track setups (state/trackTemplate.ts).
 * Clicking opens the app menu at the button - picking a preset reshapes the
 * current tracks, and one preset carries the flag for what new videos start
 * from (the checkmark). `count` only steers the tooltip; the presets themselves
 * live in localStorage, so the menu re-reads them on every open.
 */
export function TrackPresetMenuButton() {
  const [count, setCount] = useState(() => listTrackPresets().length)

  const buildItems = (): MenuItem[] => {
    const presets = listTrackPresets()
    const defaultId = defaultTrackPresetId()
    const refresh = () => setCount(listTrackPresets().length)

    const items: MenuItem[] =
      presets.length > 0
        ? presets.map((p) => ({
            label: p.name,
            checked: p.id === defaultId,
            onClick: () => applyTrackPreset(p.id),
          }))
        : [{ label: 'No saved track setups yet', disabled: true }]

    items.push({
      label: 'Save current setup as preset...',
      separator: true,
      onClick: () => {
        // A menu row is a button, so there is nowhere to type inside the menu
        // and the app has no small single-field dialog primitive. The browser
        // prompt is the honest option here.
        const name = window.prompt('Name this track setup', `Setup ${presets.length + 1}`)
        if (name === null) return
        saveTrackPresetFromCurrent(name)
        refresh()
      },
    })

    if (presets.length > 0) {
      items.push({
        label: 'Set as default for new videos',
        submenu: presets.map((p) => ({
          label: p.name,
          checked: p.id === defaultId,
          // Picking the one already flagged clears it: new videos go back to
          // the stock tracks. This is where the old "Clear" action lives now.
          onClick: () => {
            setDefaultTrackPreset(p.id === defaultId ? null : p.id)
            refresh()
          },
        })),
      })
      items.push({
        label: 'Remove preset',
        submenu: presets.map((p) => ({
          label: p.name,
          danger: true,
          onClick: () => {
            removeTrackPreset(p.id)
            refresh()
          },
        })),
      })
    }
    return items
  }

  return (
    <button
      type="button"
      data-testid="save-track-template"
      aria-haspopup="menu"
      aria-label="Track setup presets"
      title={
        count > 0
          ? `Track setups: pick one to apply it to these tracks, or save the current setup (${count} saved)`
          : 'Track setups: save the current tracks as a preset you can pick later'
      }
      className="flex shrink-0 items-center justify-center rounded-[4px] border border-border px-1.5 py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
      onClick={(e) => {
        // Anchored to the button, not the pointer, so a keyboard activation
        // (clientX/Y = 0) still opens the menu on the button instead of the
        // top-left corner. ContextMenu clamps it into the viewport.
        const r = e.currentTarget.getBoundingClientRect()
        openContextMenu({ preventDefault: () => {}, clientX: r.left, clientY: r.bottom + 4 }, buildItems())
      }}
    >
      {/* h-[17px] ≈ the siblings' 11px text line box, so all three footer
          buttons land the same height (the icon itself stays 12px). */}
      <Bookmark size={12} strokeWidth={1.75} className="h-[17px]" />
    </button>
  )
}
