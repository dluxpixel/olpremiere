import { useEffect } from 'react'
import { Inspector } from './components/Inspector'
import { KeyboardHelp } from './components/KeyboardHelp'
import { LeftPanel } from './components/LeftPanel'
import { Monitor } from './components/Monitor'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { TranscribeStatus } from './components/TranscribeStatus'
import {
  addMarker,
  clipEndS,
  clipGroupIds,
  deleteGroup,
  removeMarkerNear,
  rippleDeleteGroup,
  splitClipOnly,
  splitGroup,
  unlockedClipIds,
} from './engine/timeline'
import { nextEditPoint, prevEditPoint } from './engine/editPoints'
import { quantizeToFrame } from './engine/timecode'
import { activeSequence, isTitleClip } from './engine/types'
import { installKeymap, type Binding } from './keymap'
import {
  copySelection,
  cutSelection,
  deselectAll,
  duplicateSelection,
  moveSelectionToAdjacentTrack,
  nudgeSelection,
  pasteAtPlayhead,
  selectAllClips,
  selectClipOnAdjacentTrack,
} from './state/clipboard'
import { copyClipAttributes, pasteClipAttributes } from './state/attributes'
import { performHistoryStep } from './collab/collabControl'
import { setClipTransform, toggleClipEnabled, topAndTail } from './state/clipEdits'
import { pausePlayback, shuttle, toggleLoop, togglePlay } from './state/playbackControl'
import { clearInOut, gotoIn, gotoOut, markIn, markOut } from './state/workAreaActions'
import { punchInAtPlayhead } from './state/motionActions'
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

/**
 * Left/Right arrows: when the MONITOR is focused, paused, and a single
 * gizmo-eligible video clip is selected, nudge its x position (±1 seq-px, or
 * ±10 with Shift); otherwise step the playhead (frame, or ~1s with Shift).
 */
function arrowH(dir: -1 | 1, big: boolean) {
  const s = useStore.getState()
  if (s.ui.focusedPanel === 'monitor' && !s.ui.playing && s.ui.selection.length === 1) {
    const seq = activeSequence(s.project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === s.ui.selection[0])
    if (clip && !isTitleClip(clip)) {
      setClipTransform(clip.id, { x: clip.transform.x + dir * (big ? 10 : 1) })
      return
    }
  }
  stepFrames(dir * (big ? 30 : 1))
}

function deleteSelected(ripple: boolean) {
  const s = useStore.getState()
  // Selection may legitimately include locked-track clips; deleting them never may.
  const ids = unlockedClipIds(activeSequence(s.project), s.ui.selection)
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
function splitAtPlayhead(allTracks = false) {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Cut on the frame grid: a mid-frame playhead (playback, fine scrubs) would
  // otherwise land off-grid cuts that leave sliver fragments.
  const t = quantizeToFrame(s.ui.playheadS, seq.fps)
  // "Add edit" (C / Ctrl+K) cuts the selected clips (or all when none selected);
  // "Add edit to all tracks" (Ctrl+Shift+K) always cuts every unlocked track.
  const sel = allTracks ? [] : s.ui.selection
  const targets = seq.tracks.flatMap((tr) =>
    tr.locked
      ? []
      : tr.clips
          .filter((c) => (sel.length === 0 || sel.includes(c.id)) && t > c.startS && t < clipEndS(c))
          .map((c) => c.id),
  )
  if (targets.length === 0) return
  const selSet = new Set(sel)
  updateActiveSequence('Split at playhead', (sq) => {
    let next = sq
    // De-dupe linked partners so a group isn't split twice.
    const done = new Set<string>()
    for (const id of targets) {
      if (done.has(id)) continue
      const group = clipGroupIds(next, id)
      // Selecting ONE half of a linked A/V pair means "cut just this clip" —
      // cutting its partner too is the whole complaint. Select the pair (or
      // nothing) and it still cuts as a pair, staying linked.
      if (sel.length > 0 && !group.every((g) => selSet.has(g))) {
        done.add(id)
        next = splitClipOnly(next, id, t)
        continue
      }
      for (const gid of group) done.add(gid)
      next = splitGroup(next, id, t)
    }
    return next
  })
}

/**
 * Q / W: top-and-tail. Ripple-trim the head (Q) or tail (W) of the clip under
 * the playhead TO the playhead, closing the gap. The dead-air remover: park the
 * playhead where the good part starts, tap Q. Target = the selected clip if the
 * playhead is inside it, else the topmost unlocked clip under the playhead.
 */
// topAndTail moved to state/clipEdits.ts so the clip context menu shares it.

function buildAppBindings(): Binding[] {
  const store = () => useStore.getState()
  return [
      // comboFromEvent reads the PRODUCED character (e.key), so the '?' help key
      // arrives as 'shift+?' on US and plain '?' from synthetic events; on Czech
      // QWERTZ '?' isn't Shift+/ at all. Register every interpretation, including
      // the legacy 'shift+/', so it fires on real keyboards and stays testable.
      ...['shift+?', '?', 'shift+/'].map((combo) => ({
        combo,
        description: 'Keyboard shortcuts',
        run: () => store().setUI({ helpOpen: !store().ui.helpOpen }),
      })),
      // Routed: solo = snapshot undo; in a room = rebased (only YOUR command
      // reverts, other people's edits survive).
      { combo: 'mod+z', description: 'Undo', run: () => {
        const label = performHistoryStep('undo')
        if (label) useToasts.getState().show(`Undo: ${label}`)
      } },
      { combo: 'mod+shift+z', description: 'Redo', run: () => {
        const label = performHistoryStep('redo')
        if (label) useToasts.getState().show(`Redo: ${label}`)
      } },
      { combo: 'mod+y', description: 'Redo', run: () => {
        const label = performHistoryStep('redo')
        if (label) useToasts.getState().show(`Redo: ${label}`)
      } },
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
      { combo: 'arrowleft', description: 'Step 1 frame back (nudge clip ← in monitor)', run: () => arrowH(-1, false) },
      { combo: 'arrowright', description: 'Step 1 frame forward (nudge clip → in monitor)', run: () => arrowH(1, false) },
      { combo: 'shift+arrowleft', description: 'Step ~1s back (nudge clip ×10 in monitor)', run: () => arrowH(-1, true) },
      { combo: 'shift+arrowright', description: 'Step ~1s forward (nudge clip ×10 in monitor)', run: () => arrowH(1, true) },
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
          // Land on the LAST real frame, not exactly durationS (where no clip
          // resolves and the monitor shows black).
          const seq = activeSequence(store().project)
          store().setUI({ playheadS: Math.max(0, seq.durationS - 1 / (seq.fps || 30)) })
        },
      },
      { combo: 's', description: 'Toggle snapping', run: () => store().setUI({ snapping: !store().ui.snapping }) },
      { combo: '/', description: 'Loop playback (In/Out range)', run: toggleLoop },
      { combo: 't', description: 'Add title at playhead', run: () => addTitleClip() },
      // Jettism Motion Pack: the workhorse zoom on the selected clip.
      {
        combo: 'p',
        description: 'Punch in at playhead (selected clip)',
        run: () => {
          const id = store().ui.selection[0]
          if (id) punchInAtPlayhead(id)
        },
      },
      { combo: 'v', description: 'Selection tool', run: () => store().setUI({ tool: 'select' }) },
      // C cuts the clip(s) at the playhead right away (Premiere muscle memory). The razor
      // TOOL (click-to-cut anywhere) moved to B (Blade) so click-cutting is still available.
      { combo: 'c', description: 'Cut at playhead', run: () => splitAtPlayhead() },
      { combo: 'b', description: 'Razor (blade) tool', run: () => store().setUI({ tool: 'razor' }) }, // click-to-cut anywhere
      { combo: 'h', description: 'Hand tool', run: () => store().setUI({ tool: 'hand' }) },
      { combo: 'z', description: 'Zoom tool', run: () => store().setUI({ tool: 'zoom' }) },
      { combo: 'mod+k', description: 'Cut at playhead', run: () => splitAtPlayhead() },
      { combo: 'mod+shift+k', description: 'Add edit to ALL tracks at playhead', run: () => splitAtPlayhead(true) },
      { combo: 'mod+alt+c', description: 'Copy attributes', run: () => copyClipAttributes() },
      { combo: 'mod+alt+v', description: 'Paste attributes', run: () => pasteClipAttributes() },
      { combo: 'delete', description: 'Delete (lift)', run: () => deleteSelected(false) },
      { combo: 'backspace', description: 'Delete (lift)', run: () => deleteSelected(false) },
      { combo: 'shift+delete', description: 'Ripple delete', run: () => deleteSelected(true) },
      { combo: 'mod+c', description: 'Copy clip(s)', run: () => void copySelection() },
      { combo: 'mod+x', description: 'Cut clip(s)', run: cutSelection },
      { combo: 'mod+v', description: 'Paste at playhead', run: pasteAtPlayhead },
      { combo: 'mod+d', description: 'Duplicate clip(s)', run: duplicateSelection },
      // Work area (spec §5.6). Scopes export; I/O are the universal NLE keys.
      { combo: 'i', description: 'Mark in at playhead', run: markIn },
      { combo: 'o', description: 'Mark out at playhead', run: markOut },
      { combo: 'shift+i', description: 'Go to in point', run: gotoIn },
      { combo: 'shift+o', description: 'Go to out point', run: gotoOut },
      { combo: 'alt+x', description: 'Clear in/out', run: clearInOut },
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
      // , / . jump the playhead to the previous / next cut (any clip edge).
      { combo: ',', description: 'Jump to previous cut', run: () => {
        pausePlayback()
        store().setUI({ playheadS: prevEditPoint(activeSequence(store().project), store().ui.playheadS) })
      } },
      { combo: '.', description: 'Jump to next cut', run: () => {
        pausePlayback()
        store().setUI({ playheadS: nextEditPoint(activeSequence(store().project), store().ui.playheadS) })
      } },
      // Top-and-tail: ripple the head/tail of the clip under the playhead to it.
      { combo: 'q', description: 'Trim clip head to playhead', run: () => topAndTail('in') },
      { combo: 'w', description: 'Trim clip tail to playhead', run: () => topAndTail('out') },
      // Nudge the selection along its track (Alt = 1 frame, Shift+Alt = 10).
      { combo: 'alt+arrowleft', description: 'Nudge clip 1 frame left', run: () => nudgeSelection(-1) },
      { combo: 'alt+arrowright', description: 'Nudge clip 1 frame right', run: () => nudgeSelection(1) },
      { combo: 'shift+alt+arrowleft', description: 'Nudge clip 10 frames left', run: () => nudgeSelection(-10) },
      { combo: 'shift+alt+arrowright', description: 'Nudge clip 10 frames right', run: () => nudgeSelection(10) },
      // Move the selected clip to the adjacent same-kind track.
      { combo: 'alt+arrowup', description: 'Move clip to track above', run: () => moveSelectionToAdjacentTrack(-1) },
      { combo: 'alt+arrowdown', description: 'Move clip to track below', run: () => moveSelectionToAdjacentTrack(1) },
      { combo: 'mod+a', description: 'Select all clips', run: selectAllClips },
      { combo: 'escape', description: 'Deselect all', run: deselectAll },
      { combo: 'shift+e', description: 'Enable / disable clip', run: () => {
        const id = store().ui.selection[0]
        if (id) toggleClipEnabled(id)
      } },
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
      <TranscribeStatus />
      <ContextMenu />
      <KeyboardHelp bindings={buildAppBindings()} />
    </div>
  )
}
