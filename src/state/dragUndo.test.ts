// ONE DRAG IS ONE UNDO STEP, AND UNDO PUTS BACK EXACTLY WHAT WAS THERE, 2026-10-03.
//
// The rebuilt clip drag (engine/blockMove.ts) commits the whole block, however many clips and
// lanes it spans, as one edit. This drives the real store the way the Timeline's release does:
// dragCommit, then updateActiveSequence with its label. One press of undo must hand back the
// project he had before the drag, bit for bit, and redo the one after it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dragBlockIds } from '../engine/blockMove'
import { activeSequence, defaultTransform, newProject, type Clip, type Sequence, type Track } from '../engine/types'
import { dragCommit } from '../components/timelineGestures'
import { ASSETS } from '../components/timelineTestFixtures'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const clip = (id: string, startS: number, durS: number, linkId?: string): Clip => ({
  id,
  assetId: 'av',
  startS,
  inS: 0,
  outS: durS,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...(linkId ? { linkId } : {}),
})

const track = (id: string, kind: 'video' | 'audio', clips: Clip[]): Track => ({
  id,
  kind,
  name: id,
  height: 64,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
})

const seq = (): Sequence => activeSequence(useStore.getState().project)

beforeEach(() => {
  useStore.getState().setProject(newProject())
  // The timeline he drags on: four selected clips over two video lanes, a linked sound, and an
  // unselected obstacle where the block would first land.
  updateActiveSequence('seed', (sq) => ({
    ...sq,
    tracks: [
      track('V1', 'video', [clip('a', 0, 2), clip('b', 3, 1, 'L')]),
      track('V2', 'video', [clip('c', 1, 2), clip('d', 4, 1)]),
      track('V3', 'video', [clip('wall', 6, 3)]),
      track('A1', 'audio', [clip('bs', 3, 1, 'L')]),
    ],
  }))
})

describe('undo after a clip drag', () => {
  it('one drag of a multi-lane block is one undo step that restores every clip exactly', () => {
    const s0 = seq()
    const blockIds = dragBlockIds(s0, ['a', 'b', 'bs', 'c', 'd'], 'a')
    const drag = {
      kind: 'move' as const,
      clipId: 'a',
      grabOffsetS: 0,
      trackKind: 'video' as const,
      downClientX: 0,
      downClientY: 0,
      blockIds,
      collapseCandidate: false,
    }
    const before = useStore.getState().project
    const depth = useStore.getState().history.undo.length
    const commit = dragCommit(drag, { trackId: 'V2', tS: 4 }, ASSETS)!
    updateActiveSequence(commit.label, commit.apply)

    const after = useStore.getState().project
    expect(after).not.toBe(before)
    expect(useStore.getState().history.undo.length, 'exactly one step').toBe(depth + 1)
    // It moved as one block: every clip one lane up, the wall untouched.
    const moved = activeSequence(after)
    expect(moved.tracks.find((t) => t.id === 'V3')!.clips.map((c) => c.id).sort()).toEqual(['c', 'd', 'wall'])

    expect(useStore.getState().undo()).toBe('Move clips')
    expect(useStore.getState().project, 'the very same project object').toBe(before)
    expect(JSON.stringify(useStore.getState().project)).toBe(JSON.stringify(before))

    expect(useStore.getState().redo()).toBe('Move clips')
    expect(useStore.getState().project).toBe(after)
  })

  it('a drag that lands where it started writes nothing into his history', () => {
    const s0 = seq()
    const drag = {
      kind: 'move' as const,
      clipId: 'a',
      grabOffsetS: 0,
      trackKind: 'video' as const,
      downClientX: 0,
      downClientY: 0,
      blockIds: dragBlockIds(s0, ['a'], 'a'),
      collapseCandidate: false,
    }
    const depth = useStore.getState().history.undo.length
    const commit = dragCommit(drag, { trackId: 'V1', tS: 0 }, ASSETS)!
    updateActiveSequence(commit.label, commit.apply)
    expect(useStore.getState().history.undo.length).toBe(depth)
  })
})
