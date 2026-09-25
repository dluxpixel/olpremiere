/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import type { DragEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Sequence, type Track } from '../engine/types'
import { ASSET_MIME, SFX_MIME, TITLE_MIME } from '../state/dnd'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { AV, makeAsset } from './timelineTestFixtures'
import { useTimelineDrop, type TimelineDropContext } from './useTimelineDrop'

const hoisted = vi.hoisted(() => ({
  sfx: [] as { id: string; opts: unknown }[],
  titles: [] as { id: string; t: number }[],
}))
vi.mock('../state/sfxActions', () => ({
  insertSfxAtPlayhead: async (id: string, opts: unknown) => {
    hoisted.sfx.push({ id, opts })
  },
}))
vi.mock('../state/titleActions', () => ({
  addTitleFromShelf: (id: string, t: number) => {
    hoisted.titles.push({ id, t })
  },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)

beforeEach(() => {
  localStorage.clear()
  hoisted.sfx.length = 0
  hoisted.titles.length = 0
  const project = newProject()
  project.assets = { av: AV, snd: makeAsset({ id: 'snd', kind: 'audio', hasVideo: false }) }
  useStore.getState().setProject(project)
  useStore.getState().setUI({ playheadS: 0 })
})
afterEach(cleanup)

/** A drag event carrying `data` (mime to value), at content x (px) over `lane`. */
const dragEvent = (data: Record<string, string>, clientX: number) => {
  const preventDefault = vi.fn()
  const e = {
    clientX,
    clientY: 0,
    preventDefault,
    dataTransfer: { types: Object.keys(data), getData: (k: string) => data[k] ?? '', dropEffect: 'none' },
  }
  return e as unknown as DragEvent<HTMLDivElement> & { preventDefault: typeof preventDefault }
}

const mount = (lane: () => Track | null, over: Partial<TimelineDropContext> = {}) => {
  const ctx: TimelineDropContext = {
    seq: seq(),
    assets: useStore.getState().project.assets,
    pxPerS: 10,
    snapping: false,
    contentPoint: (e) => ({ x: e.clientX, y: 0 }),
    laneAt: () => lane(),
    snapWithIndicator: (t) => t,
    setSnapIndicatorT: vi.fn(),
    lastDragPointer: { current: null },
    maybeEdgeScroll: vi.fn(),
    stopEdgeScroll: vi.fn(),
    onEdgeStep: vi.fn(),
    ...over,
  }
  return { ctx, hook: renderHook(() => useTimelineDrop(ctx)) }
}

const firstOf = (kind: 'video' | 'audio') => seq().tracks.find((t) => t.kind === kind)!

describe('useTimelineDrop', () => {
  it('ignores a drag that carries nothing of ours', () => {
    const { hook, ctx } = mount(() => firstOf('video'))
    const e = dragEvent({ Files: 'x' }, 50)
    act(() => hook.result.current.handleDragOver(e))
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(ctx.maybeEdgeScroll).not.toHaveBeenCalled()
  })

  it('previews an asset drop on the hovered lane, edge scrolling with the lanes step', () => {
    const { hook, ctx } = mount(() => firstOf('video'))
    const e = dragEvent({ [ASSET_MIME]: 'av' }, 50)
    act(() => hook.result.current.handleDragOver(e))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.dataTransfer.dropEffect).toBe('copy')
    expect(ctx.lastDragPointer.current).toEqual({ clientX: 50, clientY: 0 })
    expect(ctx.maybeEdgeScroll).toHaveBeenCalledWith(ctx.onEdgeStep)
    expect(hook.result.current.dropPreview).toEqual({ trackId: firstOf('video').id, tS: 5 })
  })

  it('shows no preview where the drop cannot land', () => {
    const { hook } = mount(() => firstOf('video'))
    act(() => hook.result.current.handleDragOver(dragEvent({ [SFX_MIME]: 's' }, 50)))
    expect(hook.result.current.dropPreview).toBeNull()
  })

  it('drops a video with sound as a linked pair at the drop time', () => {
    const { hook, ctx } = mount(() => firstOf('video'))
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(hook.result.current.dropPreview).toBeNull()
    expect(ctx.stopEdgeScroll).toHaveBeenCalled()
    expect(ctx.setSnapIndicatorT).toHaveBeenCalledWith(null)
    const v = firstOf('video').clips
    const a = firstOf('audio').clips
    expect(v.map((c) => c.startS)).toEqual([5])
    expect(a.map((c) => c.startS)).toEqual([5])
    expect(v[0].linkId).toBeDefined()
    expect(v[0].linkId).toBe(a[0].linkId)
  })

  it('drops an audio asset on the first unlocked audio lane when hovering video', () => {
    const { hook } = mount(() => firstOf('video'))
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'snd' }, 20)))
    expect(firstOf('audio').clips.map((c) => c.startS)).toEqual([2])
  })

  it('says so when no lane of the right kind is unlocked', () => {
    useStore.setState((s) => ({
      project: {
        ...s.project,
        sequences: {
          ...s.project.sequences,
          [s.project.activeSequenceId]: { ...seq(), tracks: seq().tracks.map((t) => ({ ...t, locked: true })) },
        },
      },
    }))
    const shown: string[] = []
    const unsub = useToasts.subscribe((s) => shown.push(...s.toasts.map((t) => t.message)))
    const { hook } = mount(() => null)
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 20)))
    unsub()
    expect(shown.some((m) => m.startsWith('No unlocked video track'))).toBe(true)
  })

  it('hands a sound to the SFX inserter with its time and lane', () => {
    const { hook } = mount(() => firstOf('audio'))
    act(() => hook.result.current.handleDrop(dragEvent({ [SFX_MIME]: 'boom' }, 30)))
    expect(hoisted.sfx).toEqual([{ id: 'boom', opts: { atS: 3, trackId: firstOf('audio').id } }])
  })

  it('hands a shelf title to the title shelf with its time, snapped when snapping is on', () => {
    useStore.getState().setUI({ playheadS: 3.02 })
    const { hook } = mount(() => null, { snapping: true })
    act(() => hook.result.current.handleDrop(dragEvent({ [TITLE_MIME]: 'look' }, 30)))
    expect(hoisted.titles).toEqual([{ id: 'look', t: 3.02 }])
  })
})
