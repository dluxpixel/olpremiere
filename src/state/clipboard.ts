// Clip clipboard (session-lifetime, in-memory). Copy/cut/paste/duplicate act
// on the current selection through the pure engine ops.

import {
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
import { activeSequence } from '../engine/types'
import { useContextMenu } from './contextMenu'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

let clipboard: ClipPayload[] = []

export function copySelection(): boolean {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Copy is the one verb with NO visible effect of its own, so it has to say so
  // — otherwise the only way to find out whether it worked is to paste.
  if (s.ui.selection.length === 0) {
    useToasts.getState().show('Select a clip to copy', 'danger')
    return false
  }
  const payload = serializeClips(seq, s.ui.selection)
  if (payload.length === 0) return false
  clipboard = payload
  useToasts.getState().show(`Copied ${payload.length} clip(s)`, 'info')
  return true
}

export function cutSelection(): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Expand each selected clip to its full link group and cut a group ONLY if
  // EVERY member is unlocked. deleteGroup removes the whole linked pair, so (a)
  // both halves must land on the clipboard or a cut+paste would lose the partner,
  // and (b) a group with any locked member is protected entirely — you can't cut
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
  updateActiveSequence('Cut clip(s)', (sq) => {
    let next = sq
    for (const id of ids) next = deleteGroup(next, id)
    return next
  })
  s.setUI({ selection: [] })
}

export function pasteAtPlayhead(): void {
  const s = useStore.getState()
  // Assets can be gone if the payload outlived them (future bin deletes).
  // pasteClips itself skips locked destination tracks, so no lock guard here.
  // Title and adjustment clips carry no asset (assetId===''), keep them regardless.
  const payload = clipboard.filter(
    (p) => p.clip.title !== undefined || p.clip.adjustment === true || s.project.assets[p.assetId],
  )
  if (payload.length === 0) {
    useToasts.getState().show('Nothing to paste — copy a clip first', 'danger')
    return
  }
  let pastedIds: string[] = []
  updateActiveSequence('Paste clip(s)', (sq) => {
    const r = pasteClips(sq, payload, s.ui.playheadS)
    pastedIds = r.newIds
    return r.seq
  })
  if (pastedIds.length > 0) s.setUI({ selection: pastedIds })
}

export function duplicateSelection(): void {
  const s = useStore.getState()
  // A duplicate lands on the clip's own track — mutation, so locked filters out.
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
 * Escape: clear the selection — but ONLY when no overlay owns Escape first. The
 * context menu and help sheet have their own Escape handlers; deselecting behind
 * them would silently drop the user's selection when they only meant to close a
 * menu. Those handlers still fire (this is additive); we just don't ALSO
 * deselect while one is open.
 */
export function deselectAll(): void {
  if (useContextMenu.getState().open) return
  const s = useStore.getState()
  if (s.ui.helpOpen) return
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
  })
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
