import { useEffect, useMemo } from 'react'
import { CommandPalette, togglePalette } from './components/CommandPalette'
import { Inspector } from './components/Inspector'
import { KeyboardHelp } from './components/KeyboardHelp'
import { LeftPanel } from './components/LeftPanel'
import { Monitor } from './components/Monitor'
import { QuickStart } from './components/QuickStart'
import { RecordingStudio } from './components/RecordingStudio'
import { useRecorder } from './state/voiceRecorder'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { TranscribeStatus } from './components/TranscribeStatus'
import { MOMENT_EPS, clipKeyframeTimes } from './engine/keyframes'
import { addMarker, removeMarkerNear } from './engine/timeline'
import { nextEditPoint, prevEditPoint } from './engine/editPoints'
import { quantizeToFrame } from './engine/timecode'
import { activeSequence } from './engine/types'
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
import {
  deleteSelected,
  setAllEffectsEnabled,
  splitAtPlayhead,
  toggleClipEnabled,
  toggleMotionAtPlayhead,
  topAndTail,
} from './state/clipEdits'
import { screenshotToMedia } from './state/screenshot'
import { pausePlayback, shuttle, toggleLoop, togglePlay } from './state/playbackControl'
import { clearInOut, gotoIn, gotoOut, markIn, markOut } from './state/workAreaActions'
import { cutPunchAtPlayhead, punchInAtPlayhead, punchOutAtPlayhead } from './state/motionActions'
import { MOVES } from './engine/moves'
import { applyMoveToSelection } from './state/moveActions'
import { addTitleClip } from './state/titleActions'
import { saveNow } from './state/persistence'
import { exportProjectToFile, openProjectFilePicker } from './state/projectFile'
import { isCriticalWorkInFlight } from './state/unloadGuard'
import { updateActiveSequence, useStore, zoomIn, zoomOut } from './state/store'
import { useToasts } from './state/toasts'
import { APP_VERSION, LAST_SEEN_VERSION_KEY, checkForUpdate, displayVersion } from './appVersion'
import { olApi } from './platform'
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
 * [ and ]: park the playhead on the selected clip's previous / next keyframe.
 *
 * The unit is the MOMENT, which is exactly what clipKeyframeTimes hands the
 * timeline diamonds and what D acts on. A punch animates scale and both
 * position channels at one instant and that is ONE thing to the person looking
 * at it, so stepping per channel would cost three presses to cross a single
 * punch and would land the playhead on the same frame twice over. Landing where
 * D acts is what makes the pair a loop: jump, look, keyframe it or clear it,
 * without the mouse ever leaving the picture.
 */
function stepKeyframe(dir: -1 | 1) {
  const s = useStore.getState()
  const id = s.ui.selection[0]
  if (!id) return
  const clip = activeSequence(s.project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)
  if (!clip) return
  // Keyframe times are LOCAL to the clip, the way the lanes and the marks read
  // them; the playhead is sequence time.
  const localT = s.ui.playheadS - clip.startS
  const times = clipKeyframeTimes(clip)
  // The moment already under the playhead must not catch the jump, or ] would
  // never leave it. MOMENT_EPS is the same "same instant" test the engine uses.
  const to =
    dir < 0
      ? times.filter((t) => t < localT - MOMENT_EPS).pop()
      : times.find((t) => t > localT + MOMENT_EPS)
  if (to === undefined) return
  pausePlayback()
  s.setUI({ playheadS: clip.startS + to })
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
      ...['shift+?', '?', 'shift+/'].map<Binding>((combo) => ({
        combo,
        description: 'Keyboard shortcuts',
        domain: 'view',
        run: () => store().setUI({ helpOpen: !store().ui.helpOpen }),
      })),
      // The palette owns mod+k (the old 'Split at playhead' alias was redundant
      // bloat: C is the split key). Lists every command here with its shortcut.
      { combo: 'mod+k', description: 'Command palette', domain: 'view', run: () => togglePalette() },
      // Routed: solo = snapshot undo; in a room = rebased (only YOUR command
      // reverts, other people's edits survive).
      { combo: 'mod+z', description: 'Undo', domain: 'project', run: () => {
        const label = performHistoryStep('undo')
        if (label) useToasts.getState().show(`Undo: ${label}`)
      } },
      { combo: 'mod+shift+z', description: 'Redo', domain: 'project', run: () => {
        const label = performHistoryStep('redo')
        if (label) useToasts.getState().show(`Redo: ${label}`)
      } },
      { combo: 'mod+y', description: 'Redo', domain: 'project', run: () => {
        const label = performHistoryStep('redo')
        if (label) useToasts.getState().show(`Redo: ${label}`)
      } },
      {
        combo: 'mod+s',
        description: 'Save project',
        domain: 'project',
        run: () => {
          void saveNow().then(
            () => useToasts.getState().show('Project saved', 'success'),
            () =>
              useToasts
                .getState()
                .show('Could not save. Your work is only in memory', 'danger'),
          )
        },
      },
      // The project FILE, which was reachable only by two icon buttons nobody
      // finds. These bindings also put it in the command palette, which is built
      // from the keymap, so the one path between the browser app and the desktop
      // app is finally something you can search for by name.
      {
        combo: 'mod+shift+s',
        description: 'Back up project to a file',
        domain: 'project',
        run: () => void exportProjectToFile(),
      },
      {
        combo: 'mod+o',
        description: 'Open a project file',
        domain: 'project',
        run: () => openProjectFilePicker(),
      },
      { combo: 'space', description: 'Play / Pause', domain: 'transport', run: togglePlay },
      { combo: 'j', description: 'Shuttle reverse', domain: 'transport', run: () => shuttle(-1) },
      { combo: 'k', description: 'Pause', domain: 'transport', run: pausePlayback },
      { combo: 'l', description: 'Shuttle forward', domain: 'transport', run: () => shuttle(1) },
      { combo: 'arrowleft', description: 'Step 1 frame back', domain: 'transport', run: () => stepFrames(-1) },
      { combo: 'arrowright', description: 'Step 1 frame forward', domain: 'transport', run: () => stepFrames(1) },
      { combo: 'shift+arrowleft', description: 'Step ~1s back', domain: 'transport', run: () => stepFrames(-30) },
      { combo: 'shift+arrowright', description: 'Step ~1s forward', domain: 'transport', run: () => stepFrames(30) },
      {
        combo: 'home',
        description: 'Go to start',
        domain: 'transport',
        run: () => {
          pausePlayback()
          store().setUI({ playheadS: 0 })
        },
      },
      {
        combo: 'end',
        description: 'Go to end',
        domain: 'transport',
        run: () => {
          pausePlayback()
          // Land on the LAST real frame, not exactly durationS (where no clip
          // resolves and the monitor shows black).
          const seq = activeSequence(store().project)
          store().setUI({ playheadS: Math.max(0, seq.durationS - 1 / (seq.fps || 30)) })
        },
      },
      { combo: 's', description: 'Toggle snapping', domain: 'tools', run: () => store().setUI({ snapping: !store().ui.snapping }) },
      { combo: '/', description: 'Loop playback (In/Out range)', domain: 'transport', run: toggleLoop },
      { combo: 't', description: 'Add title at playhead', domain: 'trim', run: () => addTitleClip() },
      // Jettism Motion Pack: the workhorse zoom on the selected clip.
      {
        combo: 'p',
        description: 'Punch in at playhead (selected clip)',
        domain: 'trim',
        run: () => {
          const id = store().ui.selection[0]
          if (id) punchInAtPlayhead(id)
        },
      },
      // The other half of the verb, on the key beside it: the frame falls back
      // to the clip's own base framing and HOLDS there. "Punch out at any time
      // in the clip" was not something the app could express before.
      {
        combo: 'shift+p',
        description: 'Punch out at playhead (selected clip)',
        domain: 'trim',
        run: () => {
          const id = store().ui.selection[0]
          if (id) punchOutAtPlayhead(id)
        },
      },
      // The hard-cut punch on a key at last. It is the one most YouTube
      // punch-ins actually are, it was the only one of the three verbs with no
      // key, and "park the playhead, tap a key" is the whole gesture.
      {
        combo: 'alt+p',
        description: 'Cut punch at playhead (selected clip)',
        domain: 'trim',
        run: () => {
          const id = store().ui.selection[0]
          if (id) cutPunchAtPlayhead(id)
        },
      },
      // THE SHELF, ON THE NUMBER ROW. Click a clip, press a digit, the whole
      // move is on it. The second clip and every clip after it in the same Short
      // is ONE key. Digits 0 to 9 were completely unbound, and the keymap
      // already refuses to fire while he is typing in a field.
      ...MOVES.map<Binding>((move) => ({
        combo: String(move.digit),
        description: `Move: ${move.name}`,
        domain: 'trim',
        run: () => applyMoveToSelection(move.id),
      })),
      // The gizmo badge on a key: off a moment it snapshots the framing here,
      // on a moment it takes that moment out again.
      {
        combo: 'd',
        description: 'Keyframe the framing here, or remove it',
        domain: 'trim',
        run: () => {
          const id = store().ui.selection[0]
          if (id) toggleMotionAtPlayhead(id)
        },
      },
      // The A/B, on a key. Comparing a look against the untouched footage is
      // something he does constantly, and it used to mean clicking every eye in
      // the stack and then clicking them all back.
      {
        combo: 'shift+b',
        description: 'Turn this clip’s effects off, or back on',
        domain: 'tools',
        run: () => {
          const id = store().ui.selection[0]
          if (!id) return
          const seq = activeSequence(store().project)
          const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
          if (!clip || clip.effects.length === 0) return
          setAllEffectsEnabled(id, !clip.effects.some((e) => e.enabled))
        },
      },
      {
        combo: 'shift+s',
        description: 'Screenshot this frame into your media',
        domain: 'project',
        run: () => void screenshotToMedia(),
      },
      { combo: 'v', description: 'Selection tool', domain: 'tools', run: () => store().setUI({ tool: 'select' }) },
      // C cuts the clip(s) at the playhead right away (Premiere muscle memory). The razor
      // TOOL (click-to-cut anywhere) moved to B (Blade) so click-cutting is still available.
      // "Split", ONE name everywhere (menu, razor, here) - "Cut" stays reserved
      // for the clipboard verb (Ctrl+X) so the two never read as one action.
      { combo: 'c', description: 'Split at playhead', domain: 'trim', run: () => splitAtPlayhead() },
      { combo: 'shift+c', description: 'Split only the AUDIO at playhead', domain: 'trim', run: () => splitAtPlayhead(false, 'audio') },
      { combo: 'alt+c', description: 'Split only the VIDEO at playhead', domain: 'trim', run: () => splitAtPlayhead(false, 'video') },
      { combo: 'b', description: 'Razor (blade) tool', domain: 'tools', run: () => store().setUI({ tool: 'razor' }) }, // click-to-cut anywhere
      { combo: 'h', description: 'Hand tool', domain: 'tools', run: () => store().setUI({ tool: 'hand' }) },
      { combo: 'mod+alt+c', description: 'Copy attributes', domain: 'trim', run: () => copyClipAttributes() },
      { combo: 'mod+alt+v', description: 'Paste attributes', domain: 'trim', run: () => pasteClipAttributes() },
      { combo: 'delete', description: 'Delete (lift)', domain: 'trim', run: () => deleteSelected(false) },
      { combo: 'backspace', description: 'Delete (lift)', domain: 'trim', run: () => deleteSelected(false) },
      { combo: 'shift+delete', description: 'Ripple delete', domain: 'trim', run: () => deleteSelected(true) },
      { combo: 'mod+c', description: 'Copy clip(s)', domain: 'trim', run: () => void copySelection() },
      { combo: 'mod+x', description: 'Cut clip(s)', domain: 'trim', run: cutSelection },
      { combo: 'mod+v', description: 'Paste at playhead', domain: 'trim', run: pasteAtPlayhead },
      { combo: 'mod+d', description: 'Duplicate clip(s)', domain: 'trim', run: duplicateSelection },
      // Work area (spec §5.6). Scopes export; I/O are the universal NLE keys.
      { combo: 'i', description: 'Mark in at playhead', domain: 'transport', run: markIn },
      { combo: 'o', description: 'Mark out at playhead', domain: 'transport', run: markOut },
      { combo: 'shift+i', description: 'Go to in point', domain: 'transport', run: gotoIn },
      { combo: 'shift+o', description: 'Go to out point', domain: 'transport', run: gotoOut },
      { combo: 'alt+x', description: 'Clear in/out', domain: 'transport', run: clearInOut },
      {
        combo: 'm',
        description: 'Add marker at playhead',
        domain: 'project',
        run: () =>
          updateActiveSequence('Add marker', (sq) => addMarker(sq, store().ui.playheadS).seq),
      },
      {
        combo: 'shift+m',
        description: 'Remove marker at playhead',
        domain: 'project',
        run: () =>
          updateActiveSequence('Remove marker', (sq) =>
            removeMarkerNear(sq, store().ui.playheadS, 0.15),
          ),
      },
      { combo: 'arrowup', description: 'Select clip on track above', domain: 'selection', run: () => selectClipOnAdjacentTrack(-1) },
      { combo: 'arrowdown', description: 'Select clip on track below', domain: 'selection', run: () => selectClipOnAdjacentTrack(1) },
      // , / . jump the playhead to the previous / next cut (any clip edge).
      { combo: ',', description: 'Jump to previous cut', domain: 'transport', run: () => {
        pausePlayback()
        store().setUI({ playheadS: prevEditPoint(activeSequence(store().project), store().ui.playheadS) })
      } },
      { combo: '.', description: 'Jump to next cut', domain: 'transport', run: () => {
        pausePlayback()
        store().setUI({ playheadS: nextEditPoint(activeSequence(store().project), store().ui.playheadS) })
      } },
      // [ / ] are , / . one level in: the same jump, over the selected clip's
      // keyframes instead of the sequence's cuts. The steppers in KeyframeNav
      // do this already but had no keys, so every jump was small-target mouse
      // work on a lane where a 5-frame punch is two pixels wide.
      { combo: '[', description: 'Jump to previous keyframe', domain: 'transport', run: () => stepKeyframe(-1) },
      { combo: ']', description: 'Jump to next keyframe', domain: 'transport', run: () => stepKeyframe(1) },
      // Top-and-tail: ripple the head/tail of the clip under the playhead to it.
      { combo: 'q', description: 'Trim clip head to playhead', domain: 'trim', run: () => topAndTail('in') },
      { combo: 'w', description: 'Trim clip tail to playhead', domain: 'trim', run: () => topAndTail('out') },
      // Nudge the selection along its track (Alt = 1 frame, Shift+Alt = 10).
      { combo: 'alt+arrowleft', description: 'Nudge clip 1 frame left', domain: 'trim', run: () => nudgeSelection(-1) },
      { combo: 'alt+arrowright', description: 'Nudge clip 1 frame right', domain: 'trim', run: () => nudgeSelection(1) },
      { combo: 'shift+alt+arrowleft', description: 'Nudge clip 10 frames left', domain: 'trim', run: () => nudgeSelection(-10) },
      { combo: 'shift+alt+arrowright', description: 'Nudge clip 10 frames right', domain: 'trim', run: () => nudgeSelection(10) },
      // Move the selected clip to the adjacent same-kind track.
      { combo: 'alt+arrowup', description: 'Move clip to track above', domain: 'trim', run: () => moveSelectionToAdjacentTrack(-1) },
      { combo: 'alt+arrowdown', description: 'Move clip to track below', domain: 'trim', run: () => moveSelectionToAdjacentTrack(1) },
      { combo: 'mod+a', description: 'Select all clips', domain: 'selection', run: selectAllClips },
      { combo: 'escape', description: 'Deselect all', domain: 'selection', run: deselectAll },
      { combo: 'shift+e', description: 'Enable / disable clip', domain: 'trim', run: () => {
        const id = store().ui.selection[0]
        if (id) toggleClipEnabled(id)
      } },
      { combo: '=', description: 'Zoom in timeline', domain: 'view', run: zoomIn },
      { combo: 'shift++', description: 'Zoom in timeline', domain: 'view', run: zoomIn },
      { combo: '-', description: 'Zoom out timeline', domain: 'view', run: zoomOut },
      { combo: 'shift+_', description: 'Zoom out timeline', domain: 'view', run: zoomOut },
      {
        combo: '\\',
        description: 'Zoom to fit sequence',
        domain: 'view',
        run: () => window.dispatchEvent(new Event('olpremiere:zoom-fit')),
      },
  ]
}

function RecordingStudioMount() {
  const open = useRecorder((s) => s.studioOpen)
  return open ? <RecordingStudio /> : null
}

export default function App() {
  const { sizes, adjust } = useLayoutSizes()
  // One binding list feeds the keymap, the palette, and the help sheet, so the
  // three can never disagree.
  const bindings = useMemo(() => buildAppBindings(), [])
  useEffect(() => installKeymap(bindings), [bindings])

  // Desktop: when a newer version has downloaded, surface "Update ready → Restart"
  // so it doesn't sit invisible until the user happens to fully quit the app.
  useEffect(
    () =>
      olApi?.onUpdateReady?.((version) =>
        useToasts.getState().show(`Update ${version} is ready. Restart to install`, 'success', {
          label: 'Restart',
          onClick: () => olApi?.restartToUpdate?.(),
        }),
      ),
    [],
  )

  // Desktop auto-apply: main asks us to install a fresh-launch update. WE decide.
  // NEVER restart through an in-flight export or other critical work (that would
  // truncate the render + lose it); in that case defer to the manual restart toast.
  // Otherwise flush a save first so no edit is lost, then relaunch into the new
  // version (the post-update toast confirms it after boot).
  useEffect(
    () =>
      olApi?.onAutoApplyUpdate?.((version) => {
        if (isCriticalWorkInFlight()) {
          useToasts.getState().show(`Update ${version} is ready. Restart to install`, 'success', {
            label: 'Restart',
            onClick: () => olApi?.restartToUpdate?.(),
          })
          return
        }
        useToasts.getState().show(`Updating to v${version}…`, 'info')
        // Restart ONLY if the flush actually landed. Relaunching after a failed
        // save destroys every edit since the last successful write, and the update
        // can wait for a restart the user chooses.
        void saveNow().then(
          () => olApi?.restartToUpdate?.(),
          () =>
            useToasts.getState().show(`Could not save, so update ${version} is deferred`, 'danger', {
              label: 'Restart anyway',
              onClick: () => olApi?.restartToUpdate?.(),
            }),
        )
      }),
    [],
  )

  // Update CHECK failures must be visible. Swallowing them into console.error is
  // indistinguishable from "you're up to date", which is exactly how an
  // unreachable release feed (404) hid for weeks while the app silently never
  // updated. If the check can't run, the user gets told.
  useEffect(
    () =>
      olApi?.onUpdateError?.((message) =>
        useToasts
          .getState()
          .show(`Update check failed. You may not be on the newest version. ${message}`, 'danger', undefined, {
            durationMs: 12_000,
          }),
      ),
    [],
  )

  // On the FIRST launch after an auto-update, tell the user plainly that they're
  // now on the new build: the piece that was missing, so an update no longer
  // installs invisibly. The always-on version tag in the top bar is the passive
  // half; this toast is the active "it just happened" half. Runs once, on mount.
  useEffect(() => {
    let lastSeen: string | null = null
    try {
      lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY)
    } catch {
      return // storage blocked, so skip silently rather than risk a bad first paint
    }
    const result = checkForUpdate(lastSeen, APP_VERSION)
    if (result.kind === 'updated') {
      useToasts
        .getState()
        .show(`🎉 Updated to v${displayVersion(result.to)}. You're on the newest version`, 'success', undefined, {
          durationMs: 12_000,
        })
    }
    try {
      if (result.kind !== 'unchanged') localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION)
    } catch {
      // ignore storage failures; the toast already fired
    }
  }, [])

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
      <QuickStart />
      <RecordingStudioMount />
      <TranscribeStatus />
      <ContextMenu />
      <CommandPalette bindings={bindings} />
      <KeyboardHelp bindings={bindings} />
    </div>
  )
}
