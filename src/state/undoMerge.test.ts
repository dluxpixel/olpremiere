// Ctrl+Z has to undo the GESTURE, not one frame of it.
//
// His words, 2026-08-06: "make Ctrl-Z apply to everything, even when I slide
// the volume meter." Every continuous control in the app commits per arrow
// press (ScrubField) or per pointer release (the sliders and faders), so a ten
// press nudge cost ten presses of Ctrl+Z to walk back. pushCommand has always
// been able to fold a run of commands sharing a merge key (history.ts); these
// call sites simply never passed one.
//
// This suite drives the REAL actions against the REAL store and asserts UNDO
// STEP COUNTS, because the step count is the thing he feels. Date.now is under
// the test's control, so MERGE_WINDOW_MS is exercised deliberately rather than
// raced against the clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

import { addTrack, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Id,
  type Sequence,
} from '../engine/types'
import { setChannelForClips, setClipsFade, setClipsGainDb, setClipsPosition } from './bulkEdits'
import { nudgeSelection } from './clipboard'
import {
  deleteSelected,
  setClipDenoise,
  setClipFade,
  setClipGainDb,
  setClipSpeed,
  splitAtPlayhead,
} from './clipEdits'
import { emptyHistory, MERGE_WINDOW_MS } from './history'
import { setAutoKeyframe } from './settings'
import { updateActiveSequence, useStore } from './store'
import { setTitlesFontSize } from './titleActions'
import { setTrackPan, setTrackVolumeDb } from './trackEdits'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip =>
  seq()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!
const trackById = (id: Id) => seq().tracks.find((t) => t.id === id)!
const depth = (): number => useStore.getState().history.undo.length
const undo = (): void => void useStore.getState().undo()
const redo = (): void => void useStore.getState().redo()

/** The clock dispatch() stamps commands with. Advanced by hand, never by wall time. */
let now = 0
const tick = (ms: number): void => {
  now += ms
}

/** Drop what the seeding pushed, so any depth measured below is only the run. */
const clearHistory = (): void => useStore.setState({ history: emptyHistory() })

function seedTitle(startS: number, durS = 5): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, durS)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

function seedAudioTrack(): Id {
  const before = new Set(seq().tracks.map((t) => t.id))
  updateActiveSequence('seed track', (sq) => addTrack(sq, 'audio'))
  return seq().tracks.find((t) => !before.has(t.id))!.id
}

beforeEach(() => {
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  useStore.getState().setProject(newProject())
  // Park the playhead past both seeded clips: an align is then a plain move, so
  // these tests measure undo depth and not the keyframe policy (bulkEdits.test.ts
  // owns that).
  useStore.getState().setUI({ selection: [], playheadS: 100 })
  setAutoKeyframe(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface Ctx {
  a: Clip
  b: Clip
  trackId: Id
}

/** Two clips on V1 and one audio track, with a clean history. */
function seedCtx(): Ctx {
  const a = seedTitle(0)
  const b = seedTitle(6)
  const trackId = seq().tracks.find((t) => t.kind === 'audio')!.id
  clearHistory()
  return { a, b, trackId }
}

interface RunCase {
  name: string
  /** One commit of a run, step 0..9, each a DIFFERENT value. */
  fire: (ctx: Ctx, step: number) => void
  /** The number the run moves, read back off the store. */
  read: (ctx: Ctx) => number
  /** What that number was before the run started. */
  original: number
}

// Every continuous action, i.e. every one a user can hold an arrow key on or
// drag. Discrete actions are deliberately absent and have their own block below.
const RUNS: RunCase[] = [
  {
    name: 'setClipGainDb',
    fire: (ctx, i) => setClipGainDb(ctx.a.id, -(i + 1)),
    read: (ctx) => clipById(ctx.a.id).audioGainDb,
    original: 0,
  },
  {
    name: 'setClipFade (in)',
    fire: (ctx, i) => setClipFade(ctx.a.id, 'in', (i + 1) * 0.1),
    read: (ctx) => clipById(ctx.a.id).fadeInS,
    original: 0,
  },
  {
    name: 'setClipDenoise',
    fire: (ctx, i) => setClipDenoise(ctx.a.id, (i + 1) / 10),
    read: (ctx) => clipById(ctx.a.id).denoise ?? 0,
    original: 0,
  },
  {
    name: 'setClipSpeed',
    fire: (ctx, i) => setClipSpeed(ctx.a.id, 1 + (i + 1) * 0.1),
    read: (ctx) => clipById(ctx.a.id).speed,
    original: 1,
  },
  {
    name: 'setChannelForClips (opacity)',
    fire: (ctx, i) => setChannelForClips([ctx.a.id, ctx.b.id], 'opacity', 1 - (i + 1) * 0.05),
    read: (ctx) => clipById(ctx.a.id).opacity,
    original: 1,
  },
  {
    name: 'setClipsGainDb',
    fire: (ctx, i) => setClipsGainDb([ctx.a.id, ctx.b.id], -(i + 1)),
    read: (ctx) => clipById(ctx.b.id).audioGainDb,
    original: 0,
  },
  {
    name: 'setClipsFade (out)',
    fire: (ctx, i) => setClipsFade([ctx.a.id, ctx.b.id], 'out', (i + 1) * 0.1),
    read: (ctx) => clipById(ctx.b.id).fadeOutS,
    original: 0,
  },
  {
    name: 'setClipsPosition',
    fire: (ctx, i) => setClipsPosition([ctx.a.id, ctx.b.id], (i + 1) * 10, 0),
    read: (ctx) => clipById(ctx.b.id).transform.x,
    original: 0,
  },
  {
    name: 'setTitlesFontSize',
    fire: (ctx, i) => setTitlesFontSize([ctx.a.id, ctx.b.id], 100 + i, 'fontSizePx'),
    read: (ctx) => clipById(ctx.b.id).title!.fontSizePx,
    original: defaultTitleDef().fontSizePx,
  },
  {
    name: 'nudgeSelection',
    // Held Alt+arrow. The selection is what scopes this run, so it is what the
    // press has to set, and each press moves the clip one more frame right.
    fire: (ctx) => {
      useStore.getState().setUI({ selection: [ctx.a.id] })
      nudgeSelection(1)
    },
    read: (ctx) => clipById(ctx.a.id).startS,
    original: 0,
  },
  {
    name: 'setTrackVolumeDb',
    fire: (ctx, i) => setTrackVolumeDb(ctx.trackId, -(i + 1)),
    read: (ctx) => trackById(ctx.trackId).volumeDb,
    original: 0,
  },
  {
    name: 'setTrackPan',
    fire: (ctx, i) => setTrackPan(ctx.trackId, (i + 1) * 0.05),
    read: (ctx) => trackById(ctx.trackId).pan,
    original: 0,
  },
]

describe('one gesture, one undo step', () => {
  it.each(RUNS)('$name: ten commits in a run cost ONE Ctrl+Z back to the original', (c) => {
    const ctx = seedCtx()
    expect(c.read(ctx)).toBe(c.original)

    for (let i = 0; i < 10; i++) {
      c.fire(ctx, i)
      tick(50) // a fast nudge, well inside the merge window
    }
    const landed = c.read(ctx)
    expect(landed).not.toBe(c.original)
    expect(depth()).toBe(1)

    // ...and ONE undo goes back to before the gesture, not to the ninth value.
    undo()
    expect(c.read(ctx)).toBe(c.original)
    expect(depth()).toBe(0)

    // The whole run comes back together too.
    redo()
    expect(c.read(ctx)).toBe(landed)
  })

  it.each(RUNS)('$name: a pause longer than the merge window starts a new step', (c) => {
    const ctx = seedCtx()
    c.fire(ctx, 0)
    const afterFirst = c.read(ctx)
    tick(MERGE_WINDOW_MS + 1)
    c.fire(ctx, 1)

    expect(depth()).toBe(2)
    undo()
    expect(c.read(ctx)).toBe(afterFirst)
  })
})

describe('a merge key never reaches past its own target', () => {
  it('two clips sliding their volume in the same second stay TWO steps', () => {
    const { a, b } = seedCtx()
    setClipGainDb(a.id, -6)
    tick(50)
    setClipGainDb(b.id, -9)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(b.id).audioGainDb).toBe(0)
    expect(clipById(a.id).audioGainDb).toBe(-6)
  })

  it('fade in and fade out on ONE clip stay TWO steps', () => {
    const { a } = seedCtx()
    setClipFade(a.id, 'in', 0.4)
    tick(50)
    setClipFade(a.id, 'out', 0.7)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(a.id).fadeOutS).toBe(0)
    expect(clipById(a.id).fadeInS).toBe(0.4)
  })

  it('opacity and scale on ONE selection stay TWO steps', () => {
    const { a, b } = seedCtx()
    setChannelForClips([a.id, b.id], 'opacity', 0.5)
    tick(50)
    setChannelForClips([a.id, b.id], 'scale', 2)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(a.id).transform.scale).toBe(1)
    expect(clipById(a.id).opacity).toBe(0.5)
  })

  it('two DIFFERENT selections stay TWO steps', () => {
    const { a, b } = seedCtx()
    setClipsGainDb([a.id, b.id], -6)
    tick(50)
    setClipsGainDb([a.id], -12)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(a.id).audioGainDb).toBe(-6)
    expect(clipById(b.id).audioGainDb).toBe(-6)
  })

  it('the SAME selection in a different order is the SAME run', () => {
    // The key sorts the ids, so a selection built by shift-clicking backwards is
    // still the same gesture rather than a second undo step.
    const { a, b } = seedCtx()
    setClipsGainDb([a.id, b.id], -6)
    tick(50)
    setClipsGainDb([b.id, a.id], -12)

    expect(depth()).toBe(1)
    undo()
    expect(clipById(a.id).audioGainDb).toBe(0)
  })

  it('two tracks riding their faders stay TWO steps', () => {
    const { trackId } = seedCtx()
    const second = seedAudioTrack()
    clearHistory()

    setTrackVolumeDb(trackId, -6)
    tick(50)
    setTrackVolumeDb(second, -9)

    expect(depth()).toBe(2)
    undo()
    expect(trackById(second).volumeDb).toBe(0)
    expect(trackById(trackId).volumeDb).toBe(-6)
  })

  it('two clips nudged in the same second stay TWO steps', () => {
    const { a, b } = seedCtx()
    useStore.getState().setUI({ selection: [a.id] })
    nudgeSelection(1)
    const nudgedA = clipById(a.id).startS
    tick(50)
    useStore.getState().setUI({ selection: [b.id] })
    nudgeSelection(1)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(b.id).startS).toBe(6)
    expect(clipById(a.id).startS).toBe(nudgedA)
  })

  it('nudging along the track and aligning inside the frame stay TWO steps', () => {
    // Both are "position", which is exactly why they carry different keys: one
    // slides the clip along its track, the other moves it inside the frame.
    const { a, b } = seedCtx()
    useStore.getState().setUI({ selection: [a.id, b.id] })
    nudgeSelection(1)
    const nudgedA = clipById(a.id).startS
    tick(50)
    setClipsPosition([a.id, b.id], 40, 0)

    expect(depth()).toBe(2)
    undo()
    expect(clipById(a.id).transform.x).toBe(0)
    expect(clipById(a.id).startS).toBe(nudgedA)
  })

  it('volume and pan on ONE track stay TWO steps', () => {
    const { trackId } = seedCtx()
    setTrackVolumeDb(trackId, -6)
    tick(50)
    setTrackPan(trackId, -0.5)

    expect(depth()).toBe(2)
    undo()
    expect(trackById(trackId).pan).toBe(0)
    expect(trackById(trackId).volumeDb).toBe(-6)
  })
})

describe('discrete actions still cost one undo step each', () => {
  it('two deletes stay TWO steps', () => {
    const { a, b } = seedCtx()
    useStore.getState().setUI({ selection: [a.id] })
    deleteSelected(false)
    tick(50)
    useStore.getState().setUI({ selection: [b.id] })
    deleteSelected(false)

    expect(depth()).toBe(2)
    expect(seq().tracks[0].clips).toHaveLength(0)

    // One undo brings back only the SECOND delete. Folding these would be a far
    // worse bug than the flood this suite exists to prevent.
    undo()
    const ids = seq().tracks[0].clips.map((c) => c.id)
    expect(ids).toEqual([b.id])
  })

  it('two splits stay TWO steps', () => {
    const a = seedTitle(0, 12)
    clearHistory()

    useStore.getState().setUI({ selection: [], playheadS: 3 })
    splitAtPlayhead()
    tick(50)
    useStore.getState().setUI({ playheadS: 7 })
    splitAtPlayhead()

    expect(depth()).toBe(2)
    expect(seq().tracks[0].clips).toHaveLength(3)

    undo()
    expect(seq().tracks[0].clips).toHaveLength(2)
    expect(seq().tracks[0].clips[0].id).toBe(a.id)
  })
})
