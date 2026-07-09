import { useEffect } from 'react'
import { Inspector } from './components/Inspector'
import { KeyboardHelp } from './components/KeyboardHelp'
import { LeftPanel } from './components/LeftPanel'
import { Monitor } from './components/Monitor'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import {
  addMarker,
  clipEndS,
  clipGroupIds,
  deleteGroup,
  removeMarkerNear,
  rippleDeleteGroup,
  splitGroup,
} from './engine/timeline'
import { quantizeToFrame } from './engine/timecode'
import { activeSequence } from './engine/types'
import { installKeymap, type Binding } from './keymap'
import {
  copySelection,
  cutSelection,
  duplicateSelection,
  pasteAtPlayhead,
  selectClipOnAdjacentTrack,
} from './state/clipboard'
import { pausePlayback, shuttle, togglePlay } from './state/playbackControl'
import { addTitleClip } from './state/titleActions'
import { saveNow } from './state/persistence'
import { updateActiveSequence, useStore, zoomIn, zoomOut } from './state/store'
import { useToasts } from './state/toasts'
import { ContextMenu } from './ui/ContextMenu'
import { Splitter } from './ui/Splitter'
import { Toaster } from './ui/Toaster'
import { useLayoutSizes } from './useLayoutSizes'

function stepFrames(frames: number) {
  pausePlayback()
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const t = quantizeToFrame(s.ui.playheadS, seq.fps) + frames / seq.fps
  s.setUI({ playheadS: Math.min(Math.max(0, t), seq.durationS) })
}

function deleteSelected(ripple: boolean) {
  const s = useStore.getState()
  const ids = s.ui.selection
  if (ids.length === 0) return
  // Group-aware: deleting a linked clip removes its A/V partner too.
  updateActiveSequence(ripple ? 'Ripple delete' : 'Delete clip', (sq) => {
    let next = sq
    for (const id of ids) next = ripple ? rippleDeleteGroup(next, id) : deleteGroup(next, id)
    return next
  })
  s.setUI({ selection: [] })
}

/** Ctrl/Cmd+K: split the selected clips under the playhead — or every clip under it. */
function splitAtPlayhead() {
  const s = useStore.getState()
  const t = s.ui.playheadS
  const seq = activeSequence(s.project)
  const sel = s.ui.selection
  const targets = seq.tracks.flatMap((tr) =>
    tr.locked
      ? []
      : tr.clips
          .filter((c) => (sel.length === 0 || sel.includes(c.id)) && t > c.startS && t < clipEndS(c))
          .map((c) => c.id),
  )
  if (targets.length === 0) return
  updateActiveSequence('Split at playhead', (sq) => {
    let next = sq
    // De-dupe linked partners so a group isn't split twice.
    const done = new Set<string>()
    for (const id of targets) {
      if (done.has(id)) continue
      for (const gid of clipGroupIds(next, id)) done.add(gid)
      next = splitGroup(next, id, t)
    }
    return next
  })
}

function buildAppBindings(): Binding[] {
  const store = () => useStore.getState()
  return [
      { combo: 'shift+/', description: 'Keyboard shortcuts', run: () => store().setUI({ helpOpen: !store().ui.helpOpen }) },
      { combo: 'mod+z', description: 'Undo', run: () => store().undo() },
      { combo: 'mod+shift+z', description: 'Redo', run: () => store().redo() },
      { combo: 'mod+y', description: 'Redo', run: () => store().redo() },
      {
        combo: 'mod+s',
        description: 'Save project',
        run: () => {
          void saveNow().then(() => useToasts.getState().show('Project saved', 'success'))
        },
      },
      { combo: 'space', description: 'Play / Pause', run: togglePlay },
      { combo: 'j', description: 'Shuttle reverse', run: () => shuttle(-1) },
      { combo: 'k', description: 'Pause', run: pausePlayback },
      { combo: 'l', description: 'Shuttle forward', run: () => shuttle(1) },
      { combo: 'arrowleft', description: 'Step 1 frame back', run: () => stepFrames(-1) },
      { combo: 'arrowright', description: 'Step 1 frame forward', run: () => stepFrames(1) },
      { combo: 'shift+arrowleft', description: 'Step ~1s back', run: () => stepFrames(-30) },
      { combo: 'shift+arrowright', description: 'Step ~1s forward', run: () => stepFrames(30) },
      {
        combo: 'home',
        description: 'Go to start',
        run: () => {
          pausePlayback()
          store().setUI({ playheadS: 0 })
        },
      },
      {
        combo: 'end',
        description: 'Go to end',
        run: () => {
          pausePlayback()
          store().setUI({ playheadS: activeSequence(store().project).durationS })
        },
      },
      { combo: 's', description: 'Toggle snapping', run: () => store().setUI({ snapping: !store().ui.snapping }) },
      { combo: 't', description: 'Add title at playhead', run: () => addTitleClip() },
      { combo: 'v', description: 'Selection tool', run: () => store().setUI({ tool: 'select' }) },
      // C cuts the clip(s) at the playhead right away (Premiere muscle memory). The razor
      // TOOL (click-to-cut anywhere) moved to B (Blade) so click-cutting is still available.
      { combo: 'c', description: 'Cut at playhead', run: splitAtPlayhead },
      { combo: 'b', description: 'Razor (blade) tool', run: () => store().setUI({ tool: 'razor' }) }, // click-to-cut anywhere
      { combo: 'h', description: 'Hand tool', run: () => store().setUI({ tool: 'hand' }) },
      { combo: 'z', description: 'Zoom tool', run: () => store().setUI({ tool: 'zoom' }) },
      { combo: 'mod+k', description: 'Cut at playhead', run: splitAtPlayhead },
      { combo: 'delete', description: 'Delete (lift)', run: () => deleteSelected(false) },
      { combo: 'backspace', description: 'Delete (lift)', run: () => deleteSelected(false) },
      { combo: 'shift+delete', description: 'Ripple delete', run: () => deleteSelected(true) },
      { combo: 'mod+c', description: 'Copy clip(s)', run: () => void copySelection() },
      { combo: 'mod+x', description: 'Cut clip(s)', run: cutSelection },
      { combo: 'mod+v', description: 'Paste at playhead', run: pasteAtPlayhead },
      { combo: 'mod+d', description: 'Duplicate clip(s)', run: duplicateSelection },
      {
        combo: 'm',
        description: 'Add marker at playhead',
        run: () =>
          updateActiveSequence('Add marker', (sq) => addMarker(sq, store().ui.playheadS).seq),
      },
      {
        combo: 'shift+m',
        description: 'Remove marker at playhead',
        run: () =>
          updateActiveSequence('Remove marker', (sq) =>
            removeMarkerNear(sq, store().ui.playheadS, 0.15),
          ),
      },
      { combo: 'arrowup', description: 'Select clip on track above', run: () => selectClipOnAdjacentTrack(-1) },
      { combo: 'arrowdown', description: 'Select clip on track below', run: () => selectClipOnAdjacentTrack(1) },
      { combo: '=', description: 'Zoom in timeline', run: zoomIn },
      { combo: 'shift++', description: 'Zoom in timeline', run: zoomIn },
      { combo: '-', description: 'Zoom out timeline', run: zoomOut },
      { combo: 'shift+_', description: 'Zoom out timeline', run: zoomOut },
      {
        combo: '\\',
        description: 'Zoom to fit sequence',
        run: () => window.dispatchEvent(new Event('reel:zoom-fit')),
      },
  ]
}

function useAppKeymap() {
  useEffect(() => installKeymap(buildAppBindings()), [])
}

export default function App() {
  const { sizes, adjust } = useLayoutSizes()
  useAppKeymap()

  return (
    <div
      className="flex h-full select-none flex-col overflow-hidden text-[12px] text-text-primary"
      // Suppress the browser's context menu app-wide; specific elements open
      // our own menu instead (media cards, clips).
      onContextMenu={(e) => e.preventDefault()}
    >
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <LeftPanel width={sizes.left} />
          <Splitter
            orientation="vertical"
            testId="splitter-left"
            onDrag={(d) => adjust('left', d)}
          />
          <Monitor />
          <Splitter
            orientation="vertical"
            testId="splitter-right"
            onDrag={(d) => adjust('right', -d)}
          />
          <Inspector width={sizes.right} />
        </div>
        <Splitter
          orientation="horizontal"
          testId="splitter-bottom"
          onDrag={(d) => adjust('bottom', -d)}
        />
        <Timeline height={sizes.bottom} />
      </div>
      <Toaster />
      <ContextMenu />
      <KeyboardHelp bindings={buildAppBindings()} />
    </div>
  )
}
