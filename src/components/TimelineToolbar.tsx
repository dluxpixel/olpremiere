import { Expand, Hand, Magnet, MousePointer2, Scissors, SlidersHorizontal, Type, ZoomIn, ZoomOut } from 'lucide-react'
import { addAdjustmentClip, addTitleClip } from '../state/titleActions'
import { MAX_PX_PER_S, MIN_PX_PER_S, useStore, zoomIn, zoomOut, type Tool } from '../state/store'
import { IconButton } from '../ui/Button'

// ---------------------------------------------------------------------------
// Toolbar

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
  { tool: 'select', label: 'Selection tool', shortcut: 'V', icon: MousePointer2 },
  { tool: 'razor', label: 'Razor (blade) tool', shortcut: 'B', icon: Scissors },
  { tool: 'hand', label: 'Hand tool', shortcut: 'H', icon: Hand },
  // No Zoom tool: the timeline already zooms four ways that do not cost you the
  // pointer (wheel, the slider, = / -, and zoom-to-fit). A modal tool whose only
  // job is to zoom means clicking a clip stops selecting it until you switch
  // back. One door per feature, and this was the worst of the four.
]

export function TimelineToolbar({ onZoomFit }: { onZoomFit: () => void }) {
  const tool = useStore((s) => s.ui.tool)
  const snapping = useStore((s) => s.ui.snapping)
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const setUI = useStore((s) => s.setUI)


  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border bg-bg-panel px-2">
      {TOOLS.map(({ tool: t, label, shortcut, icon: Icon }) => (
        <IconButton
          key={t}
          size="compact"
          label={label}
          shortcut={shortcut}
          active={tool === t}
          onClick={() => setUI({ tool: t })}
        >
          <Icon size={14} strokeWidth={1.5} />
        </IconButton>
      ))}
      <div className="mx-1.5 h-4 w-px bg-border" />
      <IconButton
        size="compact"
        label={snapping ? 'Snapping on' : 'Snapping off'}
        shortcut="S"
        active={snapping}
        onClick={() => setUI({ snapping: !snapping })}
        data-testid="snap-toggle"
      >
        <Magnet size={14} strokeWidth={1.5} />
      </IconButton>
      {/* Sequences were removed 2026-07-19: separate PROJECTS already serve
          that purpose, and a second nesting level with no delete affordance
          was bloat. Projects saved with extras are split on load, see
          state/sequenceSplit.ts. */}
      <div className="mx-1.5 h-4 w-px bg-border" />
      <IconButton
        size="compact"
        label="Add title"
        shortcut="T"
        onClick={() => addTitleClip()}
        data-testid="add-title"
      >
        <Type size={14} strokeWidth={1.5} />
      </IconButton>
      <IconButton
        size="compact"
        label="Add adjustment layer (grades everything below it)"
        onClick={() => addAdjustmentClip()}
        data-testid="add-adjustment"
      >
        <SlidersHorizontal size={14} strokeWidth={1.5} />
      </IconButton>

      <div className="ml-auto flex items-center gap-1.5">
        <IconButton size="compact" label="Zoom out" shortcut="-" onClick={zoomOut}>
          <ZoomOut size={14} strokeWidth={1.5} />
        </IconButton>
        <input
          type="range"
          aria-label="Timeline zoom"
          className="h-1 w-28 accent-accent"
          min={Math.log2(MIN_PX_PER_S)}
          max={Math.log2(MAX_PX_PER_S)}
          step={0.01}
          value={Math.log2(pxPerS)}
          onChange={(e) =>
            // The toolbar renders outside the lanes component - route through
            // the same anchored-zoom event the keymap uses.
            window.dispatchEvent(
              new CustomEvent('olpremiere:zoom', { detail: { pxPerS: 2 ** Number(e.target.value) } }),
            )
          }
        />
        <IconButton size="compact" label="Zoom in" shortcut="=" onClick={zoomIn}>
          <ZoomIn size={14} strokeWidth={1.5} />
        </IconButton>
        <IconButton size="compact" label="Zoom to fit" shortcut="\" onClick={onZoomFit}>
          <Expand size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  )
}
