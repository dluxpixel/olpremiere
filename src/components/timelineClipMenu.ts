import { TRANSITION_KINDS, TRANSITION_LABELS } from '../engine/render/types'
import { clipEndS, closeAllGaps, closeGapBefore, gapBefore } from '../engine/timeline'
import { MOVES } from '../engine/moves'
import type { Clip, Id, MediaAsset, Sequence } from '../engine/types'
import { comboLabel } from '../keymap'
import { copyClipAttributes, hasClipAttributes, pasteClipAttributes } from '../state/attributes'
import { balanceAllClipLoudness, normalizeClipGain } from '../state/audioActions'
import { copySelection, cutSelection, duplicateSelection, pasteAtPlayhead } from '../state/clipboard'
import { applyEffect, crossfadeWithNeighbour, deleteSelected, removeClipTransition, setClipTransition, splitAtPlayhead, topAndTail } from '../state/clipEdits'
import { appearanceMenuItems, titleFontSizeItems } from '../state/clipMenus'
import type { MenuItem } from '../state/contextMenu'
import { cutPunchAtPlayhead, impactAtPlayhead, punchInAtPlayhead, punchOnBeats, punchOutAtPlayhead, rampWorkArea, whipToNext } from '../state/motionActions'
import { applyMoveToSelection } from '../state/moveActions'
import { copyClipMove, hasClipMove, pasteClipMove } from '../state/moveClipboard'
import { cutQuietParts } from '../state/silenceActions'
import { updateActiveSequence } from '../state/store'
import { allTextPresets, applyTextPresetToClips, saveAsCaptionStyle, useTextPresets } from '../state/textPresets'
import type { useToasts } from '../state/toasts'
import { autoCaptionEveryClip, autoCaptionFromClip } from '../state/transcribeActions'

export interface ClipMenuContext {
  /** The clip that was right-clicked. */
  clip: Clip
  seq: Sequence
  assets: Record<Id, MediaAsset>
  /** The clips the menu acts on: the whole selection when it was kept, else just `clip`. */
  selNow: Id[]
  /** Right-clicking a clip inside a multi-selection keeps that selection. */
  keepSelection: boolean
  playheadS: number
  show: ReturnType<typeof useToasts.getState>['show']
}

/**
 * The right-click menu of a clip on the timeline, built fresh for each click
 * from the clip, its track and what else is selected.
 */
export function clipContextMenuItems({ clip, seq, assets, selNow, keepSelection, playheadS, show }: ClipMenuContext): MenuItem[] {
  const titleIdsSel = seq.tracks
    .flatMap((t) => t.clips)
    .filter((c) => selNow.includes(c.id) && c.title)
    .map((c) => c.id)
  const playheadInside = playheadS > clip.startS && playheadS < clipEndS(clip)
  // Audio clips adjacent to a same-track neighbour can be crossfaded.
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
  const idx = track ? track.clips.findIndex((c) => c.id === clip.id) : -1
  const prev = track && idx > 0 ? track.clips[idx - 1] : undefined
  const next = track ? track.clips[idx + 1] : undefined
  const canXfadePrev = !!prev && Math.abs(clipEndS(prev) - clip.startS) < 1e-3
  const canXfadeNext = !!next && Math.abs(clipEndS(clip) - next.startS) < 1e-3
  const crossfadeItems =
    track?.kind === 'audio' && (canXfadePrev || canXfadeNext)
      ? [
          ...(canXfadePrev
            ? [{ label: 'Crossfade with previous', onClick: () => crossfadeWithNeighbour(clip.id, 'prev') }]
            : []),
          ...(canXfadeNext
            ? [{ label: 'Crossfade with next', separator: !canXfadePrev, onClick: () => crossfadeWithNeighbour(clip.id, 'next') }]
            : []),
        ]
      : []

  // Local Whisper captions + beat-driven punches, for audio clips with sound.
  const captionItems =
    track?.kind === 'audio' && assets[clip.assetId]?.hasAudio
      ? [
          { label: 'Level this clip', onClick: () => void normalizeClipGain(clip.id) },
          {
            label: 'Balance volume across all clips',
            onClick: () => void balanceAllClipLoudness(),
          },
          {
            // CAPTION WHAT IS SELECTED. His words, 2026-08-06: "add an option
            // to caption selected clips when I right-click and drag over some
            // clips. Make it so when I click 'Caption this clip', it just
            // captions all of them." One item, not two: the selection already
            // says how many he means, so the label just reports it back.
            // The many-clip path pools every word and lays them down in ONE
            // pass, so eight clips still make one caption track and one undo.
            label: keepSelection
              ? `Auto-Caption ${selNow.length} clips from voiceover`
              : 'Auto-Caption from voiceover',
            onClick: () =>
              keepSelection
                ? void autoCaptionEveryClip(undefined, new Set(selNow))
                : void autoCaptionFromClip(clip.id),
          },
          { label: 'Punch video on beats', onClick: () => void punchOnBeats(clip.id) },
          // Same door as the caption item on purpose: both need a transcript,
          // so they share the wait and the mental model.
          { label: 'Cut the quiet parts', onClick: () => void cutQuietParts(clip.id) },
        ]
      : []

  // Jettism Motion Pack, for video-track clips.
  const nextClip = next
  const nextTouches = !!nextClip && Math.abs(clipEndS(clip) - nextClip.startS) < 1e-3
  // Punch stays top-level (its P key is the workhorse); the rest fold into a
  // Motion submenu so the menu doesn't wall up. Speed-ramp flattens INTO it
  // (one-level submenu limit) as three leaves.
  const motionItems: MenuItem[] =
    track?.kind === 'video' && !clip.title
      ? [
          // The shelf, on the path he already right-clicks. Built from the
          // same table the tiles are, so the two can never drift apart.
          {
            label: selNow.length > 1 ? `Moves · all ${selNow.length}` : 'Moves',
            separator: true,
            submenu: MOVES.map((move) => ({
              label: move.name,
              // ⛔ NOT String(move.digit). Three shipped moves deliberately have
              // no digit, and String(undefined) is the word "undefined", which
              // the menu happily printed where the keyboard shortcut goes. The
              // keyboard side of this exact slip was fixed on 2026-08-18 (it was
              // binding the literal key "undefined"); the menu was missed.
              shortcut: move.digit === undefined ? undefined : String(move.digit),
              onClick: () => applyMoveToSelection(move.id, selNow),
            })),
          },
          {
            label: 'Punch in at playhead',
            shortcut: 'P',
            disabled: !playheadInside,
            onClick: () => punchInAtPlayhead(clip.id),
          },
          {
            label: 'Motion',
            submenu: [
              // The other two thirds of the punch verb, on the path he
              // already right-clicks for Punch in. Punch out falls back to
              // the clip's base framing and holds; Cut punch splits here and
              // simply starts the right half bigger, with no animation at all.
              {
                label: 'Punch out at playhead',
                shortcut: 'Shift+P',
                disabled: !playheadInside,
                onClick: () => punchOutAtPlayhead(clip.id),
              },
              { label: 'Cut punch at playhead', disabled: !playheadInside, onClick: () => cutPunchAtPlayhead(clip.id) },
              { label: 'Impact hit at playhead', disabled: !playheadInside, onClick: () => impactAtPlayhead(clip.id) },
              { label: 'Whip to next clip', disabled: !nextTouches, onClick: () => whipToNext(clip.id) },
              ...[2, 3, 0.5].map((f, i) => ({
                label: `Speed ramp ×${f}`,
                separator: i === 0,
                onClick: () => rampWorkArea(clip.id, f),
              })),
            ],
          },
        ]
      : []

  // Transitions had NO menu at all: audio got one-click "Crossfade with
  // previous", video got nothing but a drag from the Effects browser. Both
  // edges are offered on every video clip, because a lone edge now runs the
  // real transition rather than degrading to a fade to black.
  const transitionItems: MenuItem[] =
    track?.kind === 'video' && !clip.title
      ? (['in', 'out'] as const).map((edge) => {
          const current = edge === 'in' ? clip.transitionIn : clip.transitionOut
          const neighbour = edge === 'in' ? canXfadePrev : canXfadeNext
          return {
            label: edge === 'in' ? 'Transition in' : 'Transition out',
            separator: edge === 'in',
            submenu: [
              {
                label: 'None',
                checked: !current,
                onClick: () => removeClipTransition(clip.id, edge),
              },
              ...TRANSITION_KINDS.map((kind, i) => ({
                // A lone edge plays the transition against nothing, which is a
                // real look, so we say so rather than hiding half the list.
                label: neighbour ? TRANSITION_LABELS[kind] : `${TRANSITION_LABELS[kind]} (from nothing)`,
                separator: i === 0,
                checked: current?.type === kind,
                onClick: () => setClipTransition(clip.id, edge, kind),
              })),
            ],
          }
        })
      : []

  // One-click green-screen removal on a media clip (video/image that HAS a screen).
  // Applies the chroma-key effect, which defaults to keying green at a clean
  // strength: drop-and-done, then fine-tune in the Inspector if edges remain.
  const greenScreenItems: MenuItem[] =
    track?.kind === 'video' && !clip.title && !clip.adjustment
      ? [{ label: 'Remove green screen', onClick: () => applyEffect(clip.id, 'chromaKey') }]
      : []

  // "How it appears" - font/size quick-picks + entrance/exit/speed animation,
  // TITLE clips only (video animates via transitions + the Motion submenu).
  // All compile to keyframes (preview == export). Shared with the
  // preview-monitor menu via state/clipMenus.
  // Both target the selected TITLES - so right-clicking one of several
  // selected captions applies to all, and video clips inside a mixed
  // selection are left alone.
  const titleMenuIds = titleIdsSel.length > 1 ? titleIdsSel : [clip.id]
  const appearanceItems = [
    ...titleFontSizeItems(clip, titleMenuIds),
    ...appearanceMenuItems(clip, titleMenuIds),
  ]

  // Whole STYLE presets: font, size, weight, colour, outline, POSITION, the
  // entrance/exit animation and the effect stack, saved together and reusable.
  //
  // This used to appear ONLY when several titles were selected, so right-clicking
  // the one caption he had just styled offered no way to save it. His ask,
  // 2026-07-28: "make it so when I right-click the text, I can save a preset that
  // I can then use on the auto captions." One title is the normal case, so it is
  // the case that has to work.
  const presetTargets = titleIdsSel.length > 1 ? titleIdsSel : clip.title ? [clip.id] : []
  const bulkTitleItems: MenuItem[] =
    presetTargets.length > 0
      ? [
          {
            label: presetTargets.length > 1 ? `Style preset (all ${presetTargets.length})` : 'Style preset',
            separator: true,
            submenu: [
              ...allTextPresets().map((p) => ({
                label: p.name,
                onClick: () => applyTextPresetToClips(presetTargets, p),
              })),
              {
                label: 'Save as the caption style',
                separator: true,
                onClick: () => {
                  // Capture the clip you right-clicked (fallback: first selected title).
                  const src = clip.title ? clip.id : presetTargets[0]
                  const p = saveAsCaptionStyle(src, `Style ${useTextPresets.getState().saved.length + 1}`)
                  if (p) show(`Saved. Every new caption uses "${p.name}"`, 'success')
                },
              },
            ],
          },
        ]
      : []

  return [
    { label: 'Copy', shortcut: comboLabel('mod+c'), onClick: () => copySelection() },
    { label: 'Cut', shortcut: comboLabel('mod+x'), onClick: cutSelection },
    { label: 'Duplicate', shortcut: comboLabel('mod+d'), onClick: duplicateSelection },
    { label: 'Paste', shortcut: comboLabel('mod+v'), onClick: pasteAtPlayhead },
    { label: 'Copy attributes', shortcut: comboLabel('mod+alt+c'), separator: true, onClick: () => copyClipAttributes(clip.id) },
    {
      label: keepSelection ? `Paste attributes to ${selNow.length}` : 'Paste attributes',
      shortcut: comboLabel('mod+alt+v'),
      disabled: !hasClipAttributes(),
      onClick: () => pasteClipAttributes(keepSelection ? selNow : [clip.id]),
    },
    // The MOVE has its own pair, because Paste attributes deliberately leaves a
    // move alone (D99): a paste he thinks is about colour must never delete motion
    // he shaped by hand. Before this, reusing a hand made move meant performing it
    // again on every clip.
    { label: 'Copy move', onClick: () => copyClipMove(clip.id) },
    {
      label: keepSelection ? `Paste move to ${selNow.length}` : 'Paste move',
      disabled: !hasClipMove(),
      onClick: () => pasteClipMove(keepSelection ? selNow : [clip.id]),
    },
    ...crossfadeItems,
    ...transitionItems,
    ...captionItems,
    ...motionItems,
    ...greenScreenItems,
    ...appearanceItems,
    ...bulkTitleItems,
    {
      label: 'Trim head to playhead',
      shortcut: 'Q',
      separator: true,
      disabled: !playheadInside,
      onClick: () => topAndTail('in'),
    },
    {
      label: 'Trim tail to playhead',
      shortcut: 'W',
      disabled: !playheadInside,
      onClick: () => topAndTail('out'),
    },
    {
      // C is the branded single-key cut; the old label advertised only the
      // secondary Ctrl+K chord and hid the key everyone should learn.
      label: keepSelection ? `Split ${selNow.length} clips at playhead` : 'Split at playhead',
      shortcut: 'C',
      disabled: !playheadInside,
      // The SAME verb the C key runs. This used to split only the clip you
      // right-clicked while the Delete item one row below said "Delete 5 clips".
      onClick: () => splitAtPlayhead(),
    },
    {
      // THE LABEL NAMES WHAT GOES. Delete is selection-scoped: either half of
      // a linked pair goes alone (see deleteScoped). It used to say plain
      // "Delete" on a video clip and then take the audio with it, which is
      // exactly the surprise he hit on 2026-08-06. If a clip has a partner,
      // the item says which half this will remove.
      label: keepSelection
        ? `Delete ${selNow.length} clips`
        : clip.linkId !== undefined
          ? track?.kind === 'audio'
            ? 'Delete audio'
            : 'Delete video'
          : 'Delete',
      shortcut: 'Del',
      separator: true,
      // The SAME verb the Del key runs, lock filter included. The inline copy
      // here skipped it, so right-click Delete removed clips Del refused to.
      onClick: () => deleteSelected(false),
    },
    {
      label: keepSelection ? `Ripple delete ${selNow.length} clips` : 'Ripple delete',
      shortcut: 'Shift+Del',
      danger: true,
      onClick: () => deleteSelected(true),
    },
    {
      label: 'Close gap before',
      separator: true,
      disabled: gapBefore(seq, clip.id) <= 1e-4,
      onClick: () => updateActiveSequence('Close gap', (sq) => closeGapBefore(sq, clip.id)),
    },
    ...(track
      ? [
          {
            label: 'Close all gaps on track',
            onClick: () => updateActiveSequence('Close gaps', (sq) => closeAllGaps(sq, track.id)),
          },
        ]
      : []),
  ]
}
