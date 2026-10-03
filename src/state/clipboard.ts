// Clip clipboard (session-lifetime, in-memory). Copy/cut/paste/duplicate act
// on the current selection through the pure engine ops.

import {
  canPlace,
  clipDurationS,
  clipEndS,
  clipGroupIds,
  deleteGroup,
  duplicateClips,
  moveGroup,
  pasteClips,
  serializeClips,
  unlockedClipIds,
  type ClipPayload,
} from '../engine/timeline'
import { activeSequence, type Id, type MediaAsset, type Project } from '../engine/types'
import { useContextMenu } from './contextMenu'
import { clipMarker } from './pasteRules'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

let clipboard: ClipPayload[] = []
/**
 * The media records the copied clips point at, taken WITH them.
 *
 * ⛔ A PASTE INTO ANOTHER PROJECT USED TO DROP EVERY VIDEO AND AUDIO CLIP
 * WITHOUT A WORD. Measured 2026-10-01: a GYM clip and a title copied, mc night
 * opened, Ctrl+V, and only the title arrived. The clip was refused because its
 * media was not in that project, yet the bytes were right there: media keys are
 * shared across projects and a key another project still uses is never deleted
 * (persistence.ts deleteProject, blobSweep.ts). The record is all that was
 * missing, so the copy carries it and the paste brings it along.
 */
let clipboardAssets: Record<Id, MediaAsset> = {}

/** The records `payload` needs, read off the project it was copied from. */
function assetsFor(project: Project, payload: readonly ClipPayload[]): Record<Id, MediaAsset> {
  const out: Record<Id, MediaAsset> = {}
  for (const p of payload) {
    const a = project.assets[p.assetId]
    if (a) out[p.assetId] = a
  }
  return out
}
/** What the last clip copy wrote to the SYSTEM clipboard. See pasteRules.clipMarker. */
let systemMarker: string | null = null

/**
 * Tell the system clipboard that clips are now the newest thing he copied.
 *
 * Without it, a picture he copied an hour ago would still be sitting on the
 * system clipboard and would hijack the next Ctrl+V meant for these clips. Fire
 * and forget: the copy itself never waits on it.
 *
 * ⛔ A WRITE THE BROWSER REFUSES MUST NOT HAND CTRL+V TO AN OLD PICTURE. Then the
 * picture still on the clipboard says nothing about which came last, and the
 * clips he just copied here are the one copy known to be recent, so the next
 * paste takes them (markerLost). The full gate caught this on 2026-09-28: a page
 * with no clipboard permission, a picture left over from an earlier paste, and
 * Ctrl+V offered the picture instead of his clips.
 */
function markSystemClipboard(count: number): void {
  const text = clipMarker(count)
  systemMarker = text
  markerLost = false
  const lost = (): void => {
    if (systemMarker === text) markerLost = true
  }
  // Only a REFUSED write counts. A page with no clipboard at all can never write
  // a marker, and counting that would mean no picture could ever be pasted after
  // one clip copy.
  try {
    void navigator.clipboard?.writeText(text).catch(lost)
  } catch {
    lost()
  }
}

/** The last clip copy could not write its marker, so its clips win the next paste. */
let markerLost = false
export const clipMarkerLost = (): boolean => markerLost

/** The text the last clip copy put on the system clipboard, or null before any. */
export function clipMarkerOnSystemClipboard(): string | null {
  return systemMarker
}

export function copySelection(): boolean {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Copy is the one verb with NO visible effect of its own, so it has to say so.
  // Otherwise the only way to find out whether it worked is to paste.
  if (s.ui.selection.length === 0) {
    useToasts.getState().show('Select a clip to copy', 'danger')
    return false
  }
  const payload = serializeClips(seq, s.ui.selection)
  if (payload.length === 0) return false
  clipboard = payload
  clipboardAssets = assetsFor(s.project, payload)
  markSystemClipboard(payload.length)
  useToasts.getState().show(`Copied ${payload.length} clip(s)`, 'info')
  return true
}

export function cutSelection(): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Expand each selected clip to its full link group and cut a group ONLY if
  // EVERY member is unlocked. deleteGroup removes the whole linked pair, so (a)
  // both halves must land on the clipboard or a cut+paste would lose the partner,
  // and (b) a group with any locked member is protected entirely: you can't cut
  // half a linked pair, and a lock must not be bypassed via the partner.
  const isLocked = (id: string): boolean =>
    seq.tracks.find((t) => t.clips.some((c) => c.id === id))?.locked ?? false
  const ids: string[] = []
  const seen = new Set<string>()
  for (const sel of s.ui.selection) {
    const group = clipGroupIds(seq, sel)
    if (group.some((id) => seen.has(id))) continue
    group.forEach((id) => seen.add(id))
    if (group.every((id) => !isLocked(id))) ids.push(...group)
  }
  if (ids.length === 0) return
  const payload = serializeClips(seq, ids)
  if (payload.length === 0) return
  clipboard = payload
  clipboardAssets = assetsFor(s.project, payload)
  markSystemClipboard(payload.length)
  updateActiveSequence('Cut clip(s)', (sq) => {
    let next = sq
    for (const id of ids) next = deleteGroup(next, id)
    return next
  })
  s.setUI({ selection: [] })
}

export function pasteAtPlayhead(): void {
  pasteClipboard(useStore.getState().ui.playheadS)
}

/** True when there is something to paste. */
export function hasClipboard(): boolean {
  return clipboard.length > 0
}

/**
 * Paste onto the track he right clicked, at the time he clicked. His words,
 * 2026-09-28: *"it pastes it where I clicked it. It doesn't just paste it
 * randomly."*
 */
export function pasteAt(trackIndex: number, atS: number): void {
  pasteClipboard(atS, { trackIndex })
}

function pasteClipboard(atS: number, target?: { trackIndex: number }): void {
  const s = useStore.getState()
  if (clipboard.length === 0) {
    useToasts.getState().show('Nothing to paste. Copy a clip first', 'danger')
    return
  }
  // A clip whose media this project does not have brings the record it was
  // copied with (see `clipboardAssets`). Only a clip whose record is nowhere,
  // its media deleted before the copy, stays behind, and he is told how many.
  // pasteClips itself refuses locked destination tracks and reports how many it
  // turned away, so no lock guard here.
  // Title and adjustment clips carry no asset (assetId===''), keep them regardless.
  const brought: Record<Id, MediaAsset> = {}
  const payload = clipboard.filter((p) => {
    if (p.clip.title !== undefined || p.clip.adjustment === true || s.project.assets[p.assetId]) return true
    const record = clipboardAssets[p.assetId]
    if (record) brought[p.assetId] = record
    return !!record
  })
  const stranded = clipboard.length - payload.length
  const sayStranded = (): void =>
    useToasts
      .getState()
      .show(
        stranded === 1
          ? '1 clip needs media that is not on this computer, so it was left out'
          : `${stranded} clips need media that is not on this computer, so they were left out`,
        'danger',
      )
  if (payload.length === 0) {
    sayStranded()
    return
  }
  let pastedIds: string[] = []
  let blocked = 0
  // ONE undo step for the clips and the records they brought, so undoing the
  // paste takes both back out together.
  useStore.getState().dispatch('Paste clip(s)', (p) => {
    const seq = activeSequence(p)
    const r = pasteClips(seq, payload, atS, target)
    pastedIds = r.newIds
    blocked = r.blockedByLock
    if (r.seq === seq) return p
    const assets = Object.keys(brought).length > 0 ? { ...brought, ...p.assets } : p.assets
    return { ...p, assets, sequences: { ...p.sequences, [seq.id]: r.seq } }
  })
  if (pastedIds.length > 0) s.setUI({ selection: pastedIds })
  if (stranded > 0) sayStranded()
  // A locked track refusing the paste is a decision he made, but a paste that
  // quietly does nothing reads as a broken keyboard shortcut.
  if (blocked > 0) {
    useToasts
      .getState()
      .show(blocked === 1 ? 'That clip belongs on a locked track' : `${blocked} clips belong on locked tracks`, 'danger')
  }
}

export function duplicateSelection(): void {
  const s = useStore.getState()
  // A duplicate lands on the clip's own track: a mutation, so locked filters out.
  const ids = unlockedClipIds(activeSequence(s.project), s.ui.selection)
  if (ids.length === 0) return
  let newIds: string[] = []
  updateActiveSequence('Duplicate clip(s)', (sq) => {
    const r = duplicateClips(sq, ids)
    newIds = r.newIds
    return r.seq
  })
  if (newIds.length > 0) s.setUI({ selection: newIds })
}

/** Ctrl/Cmd+A: select every clip on unlocked tracks of the active sequence. */
export function selectAllClips(): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const ids = seq.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.map((c) => c.id))
  if (ids.length > 0) s.setUI({ selection: ids })
}

/**
 * Escape: clear the selection, but ONLY when no overlay owns Escape first. The
 * context menu and help sheet have their own Escape handlers; deselecting behind
 * them would silently drop the user's selection when they only meant to close a
 * menu. Those handlers still fire (this is additive); we just don't ALSO
 * deselect while one is open.
 */
export function deselectAll(): void {
  if (useContextMenu.getState().open) return
  const s = useStore.getState()
  if (s.ui.selection.length > 0) s.setUI({ selection: [] })
}

/**
 * Nudge the selected clips by `deltaFrames` along their own tracks. moveGroup
 * carries linked audio; a clip that cannot move (would collide or go negative)
 * stays put, so the rest of the selection still nudges.
 */
export function nudgeSelection(deltaFrames: number): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const ids = unlockedClipIds(seq, s.ui.selection)
  if (ids.length === 0) return
  const deltaS = deltaFrames / seq.fps
  // Alt+arrow repeats while held and commits per press, so a ten press nudge used
  // to cost ten presses of Ctrl+Z. Scoped to THIS selection the way mapClips does
  // it, so nudging one clip can never fold into a run on another. The field is
  // 'nudge' and not 'position' on purpose: 'position' belongs to the preview
  // gizmo (setClipsPosition), which moves transform x/y inside the frame, and a
  // slide along the track must never fold into a move across the frame.
  const mergeKey = `nudge:${[...ids].sort().join(',')}`
  // Direction-ordered so clips never transiently collide with their own group:
  // moving right, shift the rightmost first; moving left, the leftmost first.
  const withStart = ids
    .map((id) => {
      const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
      return clip ? { id, startS: clip.startS } : null
    })
    .filter((x): x is { id: string; startS: number } => x !== null)
  withStart.sort((a, b) => (deltaFrames > 0 ? b.startS - a.startS : a.startS - b.startS))

  updateActiveSequence(deltaFrames > 0 ? 'Nudge right' : 'Nudge left', (sq) => {
    let next = sq
    // De-dupe link-group members: moveGroup already carries the linked partner,
    // so nudging both selected members would shift the pair twice.
    const done = new Set<string>()
    for (const { id } of withStart) {
      if (done.has(id)) continue
      const clip = next.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
      const track = next.tracks.find((t) => t.clips.some((c) => c.id === id))
      if (!clip || !track) continue
      for (const gid of clipGroupIds(next, id)) done.add(gid)
      next = moveGroup(next, id, track.id, Math.max(0, clip.startS + deltaS))
    }
    return next
  }, mergeKey)
}

/**
 * Alt+↑/↓: move the selected clip to the adjacent same-kind unlocked track,
 * keeping its start time. Visual order matches selectClipOnAdjacentTrack.
 */
export function moveSelectionToAdjacentTrack(dir: -1 | 1): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const id = s.ui.selection[0]
  if (!id || unlockedClipIds(seq, [id]).length === 0) return
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
  if (!clip) return

  const visual = [
    ...seq.tracks.filter((t) => t.kind === 'video').reverse(),
    ...seq.tracks.filter((t) => t.kind === 'audio'),
  ]
  const fromIdx = visual.findIndex((t) => t.clips.some((c) => c.id === id))
  const kind = visual[fromIdx]?.kind
  // Walk in the requested direction to the next unlocked track of the SAME kind.
  for (let i = fromIdx + dir; i >= 0 && i < visual.length; i += dir) {
    const t = visual[i]
    if (t.kind !== kind) break
    if (t.locked) continue
    // ⛔ AT ITS OWN TIME OR NOT AT ALL. moveGroup hunts for the nearest gap that
    // fits, which is right for a drag and wrong here: on his GYM, Alt+Down sent a
    // title 13.5 s along to the end of the edit and another 16.2 s, with nothing
    // on screen to say so (measured 2026-10-01). This key promises a different
    // line, never a different moment, so a busy line keeps the clip where it is.
    if (!canPlace(t, clip.startS, clipDurationS(clip), id)) {
      useToasts.getState().show(`${t.name} is busy at this time, so the clip stayed where it is`, 'info')
      return
    }
    updateActiveSequence(dir < 0 ? 'Move clip up' : 'Move clip down', (sq) =>
      moveGroup(sq, id, t.id, clip.startS),
    )
    return
  }
}

/** ↑/↓: move the selection to the clip at the playhead on the adjacent track (visual order). */
export function selectClipOnAdjacentTrack(dir: -1 | 1): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Visual order: video tracks top→bottom (V2, V1), then audio (A1, A2).
  const visual = [
    ...seq.tracks.filter((t) => t.kind === 'video').reverse(),
    ...seq.tracks.filter((t) => t.kind === 'audio'),
  ]
  const t = s.ui.playheadS
  const clipAt = (trackIdx: number) =>
    visual[trackIdx]?.clips.find((c) => t >= c.startS && t < clipEndS(c) + 1e-9)

  const selectedId = s.ui.selection[0]
  let from = visual.findIndex((tr) => tr.clips.some((c) => c.id === selectedId))
  if (from === -1) from = dir === 1 ? -1 : visual.length
  for (let i = from + dir; i >= 0 && i < visual.length; i += dir) {
    const hit = clipAt(i)
    if (hit) {
      s.setUI({ selection: [hit.id] })
      return
    }
  }
}
