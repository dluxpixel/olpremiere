import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, newSequence, type Clip } from '../engine/types'
import { createProject } from './projectActions'
import { updateActiveSequence, useStore } from './store'
import {
  applyTemplateTracks,
  applyTrackPreset,
  defaultTrackPresetId,
  getDefaultTrackPreset,
  listTrackPresets,
  removeTrackPreset,
  saveTrackPresetFromCurrent,
  setDefaultTrackPreset,
} from './trackTemplate'

// The suite runs on the node environment; the real toast store reaches for
// window.setTimeout. Same shim the other action suites use.
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
// createProject touches playback/collab/IndexedDB, all irrelevant here.
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({
  useCollab: { getState: () => ({ session: null }) },
}))
vi.mock('./persistence', () => ({
  saveNow: vi.fn(async () => {}),
  saveProject: vi.fn(async () => {}),
  loadProjectById: vi.fn(async () => null),
  deleteProject: vi.fn(async () => {}),
}))

// node env has no localStorage, so back the presets with an in-memory shim.
const bag = new Map<string, string>()
const KEY = 'olpremiere:track-presets'
const LEGACY_KEY = 'olpremiere:track-template'

beforeEach(() => {
  bag.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, v),
    removeItem: (k: string) => void bag.delete(k),
  })
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A layout that differs from the stock V1/V2/A1/A2 in count, names, and every
 * per-track setting, plus session state (muted/solo/locked) that must NOT
 * travel with a preset. */
function seedLayout(): void {
  updateActiveSequence('layout', (sq) => ({
    ...sq,
    tracks: [
      { ...sq.tracks[0], name: 'Main', volumeDb: -3, pan: 0.5, muted: true, locked: true },
      {
        ...sq.tracks[2],
        name: 'Voice',
        volumeDb: -2,
        pan: -0.25,
        autoLevel: 'medium' as const,
        audioRole: 'voice' as const,
        solo: true,
      },
      { ...sq.tracks[3], name: 'Music', volumeDb: -12, pan: 0, audioRole: 'music' as const },
    ],
  }))
}

/** Enough of a clip to mark a track as "holds the owner's footage". */
const stubClip = (): Clip =>
  ({ id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 1, speed: 1, enabled: true }) as Clip

const LEGACY_BLOB = JSON.stringify([
  { kind: 'video', name: 'Main', volumeDb: -3, pan: 0.5 },
  { kind: 'audio', name: 'Voice', volumeDb: -2, pan: -0.25, autoLevel: 'medium', audioRole: 'voice' },
])

describe('legacy single-template migration', () => {
  it('adopts the old anonymous template as a preset named "Default", without loss', () => {
    bag.set(LEGACY_KEY, LEGACY_BLOB)
    const presets = listTrackPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0].name).toBe('Default')
    expect(presets[0].tracks).toEqual([
      { kind: 'video', name: 'Main', volumeDb: -3, pan: 0.5 },
      { kind: 'audio', name: 'Voice', volumeDb: -2, pan: -0.25, autoLevel: 'medium', audioRole: 'voice' },
    ])
    // It keeps steering new videos, exactly as the single template did.
    expect(defaultTrackPresetId()).toBe(presets[0].id)
    expect(getDefaultTrackPreset()!.name).toBe('Default')
  })

  it('retires the old key and rewrites under the new one', () => {
    bag.set(LEGACY_KEY, LEGACY_BLOB)
    listTrackPresets()
    expect(bag.has(LEGACY_KEY)).toBe(false)
    expect(bag.has(KEY)).toBe(true)
    // Stable across reads: the adopted preset keeps its id.
    const id = listTrackPresets()[0].id
    expect(listTrackPresets()[0].id).toBe(id)
  })

  it('never resurrects the legacy setup once the new shelf exists', () => {
    bag.set(LEGACY_KEY, LEGACY_BLOB)
    const id = listTrackPresets()[0].id
    removeTrackPreset(id)
    expect(listTrackPresets()).toEqual([])
    // A stale legacy key left behind by another tab must stay ignored.
    bag.set(LEGACY_KEY, LEGACY_BLOB)
    expect(listTrackPresets()).toEqual([])
  })

  it('drops a corrupt legacy blob instead of carrying junk forward', () => {
    bag.set(LEGACY_KEY, '{not json')
    expect(listTrackPresets()).toEqual([])
    expect(bag.has(LEGACY_KEY)).toBe(false)
  })
})

describe('save / list / remove round-trip', () => {
  it('captures kind/name/volumeDb/pan/autoLevel/audioRole and nothing else', () => {
    seedLayout()
    saveTrackPresetFromCurrent('Talking head')
    const [preset] = listTrackPresets()
    expect(preset.name).toBe('Talking head')
    expect(preset.tracks.map((e) => [e.kind, e.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(preset.tracks[1]).toEqual({
      kind: 'audio',
      name: 'Voice',
      volumeDb: -2,
      pan: -0.25,
      autoLevel: 'medium',
      audioRole: 'voice',
    })
    // muted/solo/locked are session state; ids/clips/heights are per-sequence.
    expect(Object.keys(preset.tracks[0]).sort()).toEqual(['kind', 'name', 'pan', 'volumeDb'])
  })

  it('keeps several named presets side by side', () => {
    seedLayout()
    saveTrackPresetFromCurrent('Talking head')
    updateActiveSequence('rename', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, name: 'Hero' } : t)),
    }))
    saveTrackPresetFromCurrent('B-roll')
    const presets = listTrackPresets()
    expect(presets.map((p) => p.name)).toEqual(['Talking head', 'B-roll'])
    expect(presets[0].tracks[0].name).toBe('Main')
    expect(presets[1].tracks[0].name).toBe('Hero')
    expect(presets[0].id).not.toBe(presets[1].id)
  })

  it('saving over a name updates that preset in place, keeping its id and its default flag', () => {
    seedLayout()
    const first = saveTrackPresetFromCurrent('Talking head')!
    updateActiveSequence('rename', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, name: 'Hero' } : t)),
    }))
    const again = saveTrackPresetFromCurrent('Talking head')!
    expect(listTrackPresets()).toHaveLength(1)
    expect(again.id).toBe(first.id)
    expect(listTrackPresets()[0].tracks[0].name).toBe('Hero')
    expect(defaultTrackPresetId()).toBe(first.id)
  })

  it('the FIRST preset becomes the default; later ones do not steal the flag', () => {
    seedLayout()
    const first = saveTrackPresetFromCurrent('Talking head')!
    expect(defaultTrackPresetId()).toBe(first.id)
    const second = saveTrackPresetFromCurrent('B-roll')!
    expect(defaultTrackPresetId()).toBe(first.id)
    expect(second.id).not.toBe(first.id)
  })

  it('refuses a blank name', () => {
    seedLayout()
    expect(saveTrackPresetFromCurrent('   ')).toBeNull()
    expect(listTrackPresets()).toEqual([])
  })

  it('remove takes the preset out and clears the flag when it held it', () => {
    seedLayout()
    const a = saveTrackPresetFromCurrent('Talking head')!
    const b = saveTrackPresetFromCurrent('B-roll')!
    removeTrackPreset(a.id)
    expect(listTrackPresets().map((p) => p.name)).toEqual(['B-roll'])
    expect(defaultTrackPresetId()).toBeNull()
    // Removing a non-default one leaves the flag alone.
    setDefaultTrackPreset(b.id)
    saveTrackPresetFromCurrent('Third')
    removeTrackPreset(listTrackPresets().find((p) => p.name === 'Third')!.id)
    expect(defaultTrackPresetId()).toBe(b.id)
  })

  it('setDefaultTrackPreset accepts null and ignores unknown ids', () => {
    seedLayout()
    const a = saveTrackPresetFromCurrent('Talking head')!
    setDefaultTrackPreset(null)
    expect(defaultTrackPresetId()).toBeNull()
    expect(getDefaultTrackPreset()).toBeNull()
    setDefaultTrackPreset('nope')
    expect(defaultTrackPresetId()).toBeNull()
    setDefaultTrackPreset(a.id)
    expect(defaultTrackPresetId()).toBe(a.id)
  })

  it('rejects corrupt storage and tolerates a missing localStorage', () => {
    bag.set(KEY, '{not json')
    expect(listTrackPresets()).toEqual([])
    // A malformed preset is dropped ALONE; the healthy ones survive.
    bag.set(
      KEY,
      JSON.stringify({
        presets: [
          { id: 'p1', name: 'Good', tracks: [{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0 }] },
          { id: 'p2', name: 'Bad kind', tracks: [{ kind: 'nope', name: 'x', volumeDb: 0, pan: 0 }] },
          { id: 'p3', name: 'Empty', tracks: [] },
          { name: 'No id', tracks: [{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0 }] },
        ],
        defaultId: 'p2',
      }),
    )
    expect(listTrackPresets().map((p) => p.name)).toEqual(['Good'])
    // defaultId pointed at a preset that did not survive: healed to null.
    expect(defaultTrackPresetId()).toBeNull()
    // Unknown enum values are dropped; the valid core survives.
    bag.set(
      KEY,
      JSON.stringify({
        presets: [
          {
            id: 'p1',
            name: 'Good',
            tracks: [{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0, autoLevel: 'MAX', audioRole: 'drums' }],
          },
        ],
        defaultId: 'p1',
      }),
    )
    expect(listTrackPresets()[0].tracks).toEqual([{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0 }])
    // No localStorage at all (SSR / lockdown): every function is a safe no-op.
    vi.stubGlobal('localStorage', undefined)
    expect(() => saveTrackPresetFromCurrent('x')).not.toThrow()
    expect(listTrackPresets()).toEqual([])
    expect(getDefaultTrackPreset()).toBeNull()
    expect(() => removeTrackPreset('p1')).not.toThrow()
    expect(() => setDefaultTrackPreset(null)).not.toThrow()
  })
})

describe('applyTrackPreset', () => {
  /** Depth of the undo stack, so "one undo step" is measured, not assumed. */
  const undoDepth = (): number => useStore.getState().history.undo.length

  it('reshapes the active sequence in ONE undo step', () => {
    seedLayout()
    const preset = saveTrackPresetFromCurrent('Talking head')!
    // Back to the stock four tracks, then apply the preset onto them.
    useStore.getState().setProject(newProject())
    const before = undoDepth()
    applyTrackPreset(preset.id)
    expect(undoDepth()).toBe(before + 1)

    const tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(tracks[0].volumeDb).toBe(-3)
    expect(tracks[0].pan).toBe(0.5)
    expect(tracks[1].autoLevel).toBe('medium')
    expect(tracks[1].audioRole).toBe('voice')
    expect(tracks[2].audioRole).toBe('music')
    expect(tracks[2].autoLevel).toBeUndefined()

    // One undo puts the whole layout back.
    useStore.getState().undo()
    expect(activeSequence(useStore.getState().project).tracks.map((t) => t.name)).toEqual([
      'V1',
      'V2',
      'A1',
      'A2',
    ])
  })

  it('reuses the matched tracks, so their clips survive the reshape', () => {
    seedLayout()
    const preset = saveTrackPresetFromCurrent('Talking head')!
    useStore.getState().setProject(newProject())
    const stock = activeSequence(useStore.getState().project).tracks
    applyTrackPreset(preset.id)
    const tracks = activeSequence(useStore.getState().project).tracks
    // V1 -> Main, A1 -> Voice, A2 -> Music: same track objects, renamed.
    expect(tracks[0].id).toBe(stock[0].id)
    expect(tracks[1].id).toBe(stock[2].id)
    expect(tracks[2].id).toBe(stock[3].id)
  })

  it('clears autoLevel/audioRole the preset does not carry', () => {
    updateActiveSequence('plain', (sq) => ({ ...sq, tracks: [sq.tracks[0], sq.tracks[2]] }))
    const preset = saveTrackPresetFromCurrent('Plain')!
    updateActiveSequence('dirty', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, autoLevel: 'high' as const, audioRole: 'music' as const })),
    }))
    applyTrackPreset(preset.id)
    const tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.every((t) => t.autoLevel === undefined && t.audioRole === undefined)).toBe(true)
    expect(tracks.every((t) => !('autoLevel' in t) && !('audioRole' in t))).toBe(true)
  })

  it('drops surplus EMPTY tracks but keeps any that still hold clips', () => {
    updateActiveSequence('one video', (sq) => ({ ...sq, tracks: [sq.tracks[0], sq.tracks[2]] }))
    const preset = saveTrackPresetFromCurrent('Lean')!
    // Back to four stock tracks and park a clip on the surplus A2.
    useStore.getState().setProject(newProject())
    updateActiveSequence('park a clip', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 3 ? { ...t, clips: [stubClip()] } : t)),
    }))
    applyTrackPreset(preset.id)
    const tracks = activeSequence(useStore.getState().project).tracks
    // V2 and A1 were empty surplus and went; A2 stayed because it has footage.
    expect(tracks.map((t) => t.name)).toEqual(['V1', 'A1', 'A2'])
    expect(tracks[2].clips).toHaveLength(1)
  })

  it('is a no-op (no undo entry) when the tracks already match, and on an unknown id', () => {
    seedLayout()
    const preset = saveTrackPresetFromCurrent('Talking head')!
    applyTrackPreset(preset.id)
    const depth = undoDepth()
    applyTrackPreset(preset.id)
    expect(undoDepth()).toBe(depth)
    applyTrackPreset('nope')
    expect(undoDepth()).toBe(depth)
  })
})

describe('the default flag drives new-project creation', () => {
  it('returns the defaults (same reference) when nothing is flagged', () => {
    const defaults = newSequence().tracks
    expect(applyTemplateTracks(defaults)).toBe(defaults)
    seedLayout()
    saveTrackPresetFromCurrent('Talking head')
    setDefaultTrackPreset(null)
    expect(applyTemplateTracks(defaults)).toBe(defaults)
  })

  it('builds fresh, clean tracks from the DEFAULT preset', () => {
    seedLayout()
    saveTrackPresetFromCurrent('Talking head')
    const defaults = newSequence().tracks
    const built = applyTemplateTracks(defaults)
    expect(built.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(built[1].volumeDb).toBe(-2)
    expect(built[1].pan).toBe(-0.25)
    expect(built[1].autoLevel).toBe('medium')
    expect(built[1].audioRole).toBe('voice')
    expect(built[2].audioRole).toBe('music')
    expect(built[2].autoLevel).toBeUndefined()
    // Session state never comes back on; content starts empty.
    expect(built.every((t) => !t.muted && !t.solo && !t.locked && t.clips.length === 0)).toBe(true)
    // Fresh ids on EVERY application: tracks are never shared.
    const again = applyTemplateTracks(defaults)
    expect(again[0].id).not.toBe(built[0].id)
  })

  it('a new project starts from the flagged preset, not from whichever was saved last', async () => {
    seedLayout()
    saveTrackPresetFromCurrent('Talking head')
    // A second, different preset that is NOT the default.
    updateActiveSequence('lean', (sq) => ({ ...sq, tracks: [{ ...sq.tracks[0], name: 'Solo' }] }))
    const lean = saveTrackPresetFromCurrent('Lean')!
    const sourceIds = activeSequence(useStore.getState().project).tracks.map((t) => t.id)

    await createProject()
    let tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(tracks[0].volumeDb).toBe(-3)
    expect(tracks[1].audioRole).toBe('voice')
    // New tracks, not references into the project the preset came from.
    for (const t of tracks) expect(sourceIds).not.toContain(t.id)
    expect(tracks.every((t) => !t.muted && !t.solo && !t.locked && t.clips.length === 0)).toBe(true)

    // Move the flag: the NEXT new project follows it.
    setDefaultTrackPreset(lean.id)
    await createProject()
    tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => t.name)).toEqual(['Solo'])
  })

  it('without any preset a new project keeps the stock layout', async () => {
    await createProject()
    const tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'A1', 'A2'])
  })
})
