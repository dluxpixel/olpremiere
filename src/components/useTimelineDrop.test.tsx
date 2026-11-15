/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import type { DragEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Sequence, type Track } from '../engine/types'
import { SFX_LIBRARY } from '../engine/sfx/sfx'
import { clipDurationS } from '../engine/timeline'
import { ASSET_MIME, LIBRARY_MIME, SFX_MIME, TITLE_MIME, clearDragRecord, getDragRecord, setDragRecord } from '../state/dnd'
import { TITLE_SHELF } from '../state/titleShelf'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { AV, makeAsset, makeClip } from './timelineTestFixtures'
import { useTimelineDrop, type TimelineDropContext } from './useTimelineDrop'

const hoisted = vi.hoisted(() => ({
  sfx: [] as { id: string; opts: unknown }[],
  titles: [] as { id: string; t: number }[],
  library: [] as { id: string; place: unknown }[],
}))
vi.mock('../state/sfxActions', () => ({
  insertSfxAtPlayhead: async (id: string, opts: unknown) => {
    hoisted.sfx.push({ id, opts })
  },
}))
// A Library item's copy into the project is library.test.ts's business. Here
// only the handoff matters: which item, when, and on which lane.
vi.mock('../state/library', () => ({
  useLibrary: {
    getState: () => ({
      items: [
        { id: 'lib-sound', name: 'meow.wav', kind: 'audio', durationS: 2, hasAudio: true, hasVideo: false },
        { id: 'lib-clip', name: 'intro.mp4', kind: 'video', durationS: 4, hasAudio: false, hasVideo: true },
      ],
    }),
  },
  addLibraryItemToTimeline: async (id: string, place: unknown) => {
    hoisted.library.push({ id, place })
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
  hoisted.library.length = 0
  const project = newProject()
  project.assets = { av: AV, snd: makeAsset({ id: 'snd', kind: 'audio', hasVideo: false }) }
  useStore.getState().setProject(project)
  useStore.getState().setUI({ playheadS: 0 })
  clearDragRecord()
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
    expect(hook.result.current.dropPreview).toEqual({ trackId: firstOf('video').id, tS: 5, ghosts: [] })
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
    // 3.02 s is frame 90.6: the drop snaps to the playhead's frame, 91.
    useStore.getState().setUI({ playheadS: 3.02 })
    const { hook } = mount(() => null, { snapping: true })
    act(() => hook.result.current.handleDrop(dragEvent({ [TITLE_MIME]: 'look' }, 30)))
    expect(hoisted.titles).toEqual([{ id: 'look', t: 91 / 30 }])
  })

  it('previews a Library item like bin media and hands it over with the drop time and lane', () => {
    const { hook } = mount(() => firstOf('audio'))
    act(() => hook.result.current.handleDragOver(dragEvent({ [LIBRARY_MIME]: 'lib-sound' }, 30)))
    expect(hook.result.current.dropPreview).toEqual({ trackId: firstOf('audio').id, tS: 3, ghosts: [] })
    act(() => hook.result.current.handleDrop(dragEvent({ [LIBRARY_MIME]: 'lib-sound' }, 30)))
    expect(hoisted.library).toEqual([{ id: 'lib-sound', place: { atS: 3, trackId: firstOf('audio').id, exact: true } }])
  })

  it('sends a Library video to a video lane even when dropped over an audio one', () => {
    const { hook } = mount(() => firstOf('audio'))
    act(() => hook.result.current.handleDrop(dragEvent({ [LIBRARY_MIME]: 'lib-clip' }, 10)))
    expect(hoisted.library).toEqual([{ id: 'lib-clip', place: { atS: 1, trackId: firstOf('video').id, exact: true } }])
  })
})


// The ghost clip: where the drop will land, on which track, and how long. It is
// read off the SAME pure insert the drop runs, so it cannot disagree with it.
describe('useTimelineDrop drop ghost', () => {
  const lane = (kind: 'video' | 'audio', i = 0): Track => seq().tracks.filter((t) => t.kind === kind)[i]!
  const allClips = () => seq().tracks.flatMap((t) => t.clips.map((c) => ({ trackId: t.id, clip: c })))
  /** What a drop put on the sequence: the clips that were not there before it. */
  const created = (before: string[]) => allClips().filter((x) => !before.includes(x.clip.id))

  it('shows a bin video with sound as two ghosts of its own length, one per lane', () => {
    const { hook } = mount(() => lane('video'))
    setDragRecord('asset', 'av')
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    const p = hook.result.current.dropPreview!
    expect(p.ghosts).toEqual([
      { trackId: lane('video').id, tS: 5, durS: 10, label: 'a.mp4' },
      { trackId: lane('audio').id, tS: 5, durS: 10, label: 'a.mp4' },
    ])
  })

  it('puts the ghost exactly where the drop puts the clip, on a lane that is taken at the pointer', () => {
    // V1 is busy from 0 to 20 s: the insert passes the pair to the next free lines.
    useStore.getState().dispatch('seed', (p) => {
      const sq = p.sequences[p.activeSequenceId]!
      const busy = makeClip({ startS: 0, outS: 20 })
      const tracks = sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [busy] } : t))
      return { ...p, sequences: { ...p.sequences, [sq.id]: { ...sq, tracks } } }
    })
    const { hook } = mount(() => lane('video'))
    setDragRecord('asset', 'av')
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    const ghosts = hook.result.current.dropPreview!.ghosts
    expect(ghosts[0]!.trackId).toBe(lane('video', 1).id)
    const before = allClips().map((x) => x.clip.id)
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    const made = created(before)
    expect(made.map((x) => ({ trackId: x.trackId, tS: x.clip.startS, durS: clipDurationS(x.clip) }))).toEqual(
      ghosts.map((g) => ({ trackId: g.trackId, tS: g.tS, durS: g.durS })),
    )
  })

  it('shows the frame the clip will start on, not the raw pointer time', () => {
    // 5.016 s is between frames at 30 fps: the insert rounds it to frame 150.
    const { hook } = mount(() => lane('video'), { snapWithIndicator: () => 5.016 })
    setDragRecord('asset', 'av')
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    const before = allClips().map((x) => x.clip.id)
    const shown = hook.result.current.dropPreview!.ghosts[0]!.tS
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(shown).toBe(5)
    expect(created(before).every((x) => x.clip.startS === shown)).toBe(true)
  })

  it('gives a picture the same default length the insert gives it', () => {
    const png = makeAsset({ id: 'png', kind: 'image', durationS: 0, hasAudio: false, hasVideo: true })
    useStore.getState().setProject({ ...useStore.getState().project, assets: { ...useStore.getState().project.assets, png } })
    const { hook } = mount(() => lane('video'))
    setDragRecord('asset', 'png')
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'png' }, 20)))
    const ghosts = hook.result.current.dropPreview!.ghosts
    expect(ghosts).toEqual([{ trackId: lane('video').id, tS: 2, durS: 5, label: 'a.mp4' }])
    const before = allClips().map((x) => x.clip.id)
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'png' }, 20)))
    expect(clipDurationS(created(before)[0]!.clip)).toBe(5)
  })

  it('shows a sound ghost on the hovered audio lane, with the sound its own length', () => {
    const def = SFX_LIBRARY[0]!
    const { hook } = mount(() => lane('audio', 1))
    setDragRecord('sfx', def.id)
    act(() => hook.result.current.handleDragOver(dragEvent({ [SFX_MIME]: def.id }, 30)))
    expect(hook.result.current.dropPreview!.ghosts).toEqual([
      { trackId: lane('audio', 1).id, tS: 3, durS: def.durationS, label: def.name },
    ])
  })

  it('shows a shelf title ghost on the lane titles go to, at the shelf length', () => {
    const look = TITLE_SHELF[0]!
    const { hook } = mount(() => lane('video'))
    setDragRecord('title', look.id)
    act(() => hook.result.current.handleDragOver(dragEvent({ [TITLE_MIME]: look.id }, 30)))
    expect(hook.result.current.dropPreview!.ghosts).toEqual([
      { trackId: lane('video', 1).id, tS: 3, durS: look.durationS, label: look.name },
    ])
  })

  it('shows a Library item ghost of the item length', () => {
    const { hook } = mount(() => lane('video'))
    setDragRecord('library', 'lib-clip')
    act(() => hook.result.current.handleDragOver(dragEvent({ [LIBRARY_MIME]: 'lib-clip' }, 10)))
    expect(hook.result.current.dropPreview!.ghosts).toEqual([
      { trackId: lane('video').id, tS: 1, durS: 4, label: 'intro.mp4' },
    ])
  })

  it('clears on a leave out of the lanes, on dragend and on the drop', () => {
    const { hook } = mount(() => lane('video'))
    const over = () => {
      setDragRecord('asset', 'av')
      act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
      expect(hook.result.current.dropPreview!.ghosts).toHaveLength(2)
    }
    over()
    const leave = { relatedTarget: null, currentTarget: document.createElement('div') }
    act(() => hook.result.current.handleDragLeave(leave as unknown as DragEvent<HTMLDivElement>))
    expect(hook.result.current.dropPreview).toBeNull()
    over()
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })
    expect(hook.result.current.dropPreview).toBeNull()
    expect(getDragRecord()).toBeNull()
    over()
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(hook.result.current.dropPreview).toBeNull()
    expect(getDragRecord()).toBeNull()
  })

  it('shows no ghost once the lane refuses the drop', () => {
    let hovered: Track = lane('audio')
    const { hook } = mount(() => hovered)
    const def = SFX_LIBRARY[0]!
    setDragRecord('sfx', def.id)
    act(() => hook.result.current.handleDragOver(dragEvent({ [SFX_MIME]: def.id }, 30)))
    expect(hook.result.current.dropPreview!.ghosts).toHaveLength(1)
    hovered = lane('video')
    act(() => hook.result.current.handleDragOver(dragEvent({ [SFX_MIME]: def.id }, 30)))
    expect(hook.result.current.dropPreview).toBeNull()
  })

  it('keeps the plain line, and still drops, when the drag has no record', () => {
    const { hook } = mount(() => lane('video'))
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(hook.result.current.dropPreview).toEqual({ trackId: lane('video').id, tS: 5, ghosts: [] })
    act(() => hook.result.current.handleDrop(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(lane('video').clips.map((c) => c.startS)).toEqual([5])
  })

  it('ignores a record of another kind than the drag carries', () => {
    const { hook } = mount(() => lane('video'))
    setDragRecord('sfx', SFX_LIBRARY[0]!.id)
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(hook.result.current.dropPreview!.ghosts).toEqual([])
  })

  it('works the ghost out again only when the lane or the time changes', () => {
    const { hook } = mount(() => lane('video'))
    setDragRecord('asset', 'av')
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    const first = hook.result.current.dropPreview
    // The same lane and the same snapped time: nothing new.
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 50)))
    expect(hook.result.current.dropPreview).toBe(first)
    act(() => hook.result.current.handleDragOver(dragEvent({ [ASSET_MIME]: 'av' }, 80)))
    expect(hook.result.current.dropPreview).not.toBe(first)
    expect(hook.result.current.dropPreview!.ghosts[0]!.tS).toBe(8)
  })
})
