// Clip clipboard (session-lifetime, in-memory). Copy/cut/paste/duplicate act
// on the current selection through the pure engine ops.

import {
  clipEndS,
  deleteClip,
  duplicateClips,
  pasteClips,
  serializeClips,
  type ClipPayload,
} from '../engine/timeline'
import { activeSequence } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

let clipboard: ClipPayload[] = []

export function copySelection(): boolean {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  if (s.ui.selection.length === 0) return false
  const payload = serializeClips(seq, s.ui.selection)
  if (payload.length === 0) return false
  clipboard = payload
  return true
}

export function cutSelection(): void {
  if (!copySelection()) return
  const s = useStore.getState()
  const ids = s.ui.selection
  updateActiveSequence('Cut clip(s)', (sq) => {
    let next = sq
    for (const id of ids) next = deleteClip(next, id)
    return next
  })
  s.setUI({ selection: [] })
}

export function pasteAtPlayhead(): void {
  const s = useStore.getState()
  // Assets can be gone if the payload outlived them (future bin deletes).
  const payload = clipboard.filter((p) => s.project.assets[p.assetId])
  if (payload.length === 0) return
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
  if (s.ui.selection.length === 0) return
  let newIds: string[] = []
  updateActiveSequence('Duplicate clip(s)', (sq) => {
    const r = duplicateClips(sq, s.ui.selection)
    newIds = r.newIds
    return r.seq
  })
  if (newIds.length > 0) s.setUI({ selection: newIds })
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
