import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, newSequence } from '../engine/types'
import { createProject } from './projectActions'
import { updateActiveSequence, useStore } from './store'
import {
  applyTemplateTracks,
  clearTrackTemplate,
  loadTrackTemplate,
  saveTrackTemplate,
} from './trackTemplate'

// The suite runs on the node environment; the real toast store reaches for
// window.setTimeout. Same shim the other action suites use.
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
// createProject touches playback/collab/IndexedDB — all irrelevant here.
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

// node env has no localStorage — back the template with an in-memory shim.
const bag = new Map<string, string>()
const KEY = 'reel:track-template'

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
 * per-track setting — plus session state (muted/solo/locked) that must NOT
 * travel with the template. */
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

describe('template round-trip', () => {
  it('captures kind/name/volumeDb/pan/autoLevel/audioRole — and nothing else', () => {
    seedLayout()
    saveTrackTemplate()
    const tpl = loadTrackTemplate()!
    expect(tpl.map((e) => [e.kind, e.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(tpl[1]).toEqual({
      kind: 'audio',
      name: 'Voice',
      volumeDb: -2,
      pan: -0.25,
      autoLevel: 'medium',
      audioRole: 'voice',
    })
    // muted/solo/locked are session state; ids/clips/heights are per-sequence.
    expect(Object.keys(tpl[0]).sort()).toEqual(['kind', 'name', 'pan', 'volumeDb'])
  })

  it('a second save overwrites the previous template', () => {
    seedLayout()
    saveTrackTemplate()
    updateActiveSequence('rename', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, name: 'Hero' } : t)),
    }))
    saveTrackTemplate()
    expect(loadTrackTemplate()![0].name).toBe('Hero')
  })

  it('clearTrackTemplate removes it', () => {
    seedLayout()
    saveTrackTemplate()
    clearTrackTemplate()
    expect(loadTrackTemplate()).toBeNull()
  })
})

describe('applyTemplateTracks', () => {
  it('returns the defaults (same reference) when no template exists', () => {
    const defaults = newSequence().tracks
    expect(applyTemplateTracks(defaults)).toBe(defaults)
  })

  it('builds fresh, clean tracks from the template', () => {
    seedLayout()
    saveTrackTemplate()
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
    // Fresh ids on EVERY application — tracks are never shared.
    const again = applyTemplateTracks(defaults)
    expect(again[0].id).not.toBe(built[0].id)
  })

  it('rejects corrupt or malformed storage and tolerates a missing localStorage', () => {
    bag.set(KEY, '{not json')
    expect(loadTrackTemplate()).toBeNull()
    bag.set(KEY, JSON.stringify([{ kind: 'nope', name: 'x', volumeDb: 0, pan: 0 }]))
    expect(loadTrackTemplate()).toBeNull()
    bag.set(KEY, JSON.stringify([{ kind: 'audio', name: 'x', volumeDb: 'loud', pan: 0 }]))
    expect(loadTrackTemplate()).toBeNull()
    bag.set(KEY, '[]') // empty layout ≡ no template
    expect(loadTrackTemplate()).toBeNull()
    // Unknown enum values are dropped; the valid core survives.
    bag.set(KEY, JSON.stringify([{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0, autoLevel: 'MAX', audioRole: 'drums' }]))
    expect(loadTrackTemplate()).toEqual([{ kind: 'audio', name: 'x', volumeDb: 0, pan: 0 }])
    // No localStorage at all (SSR / lockdown): every function is a safe no-op.
    vi.stubGlobal('localStorage', undefined)
    expect(() => saveTrackTemplate()).not.toThrow()
    expect(loadTrackTemplate()).toBeNull()
    expect(() => clearTrackTemplate()).not.toThrow()
  })
})

describe('creation-time application', () => {
  it('a new project starts from the template', async () => {
    seedLayout()
    saveTrackTemplate()
    const sourceIds = activeSequence(useStore.getState().project).tracks.map((t) => t.id)
    await createProject()
    const tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'Main'],
      ['audio', 'Voice'],
      ['audio', 'Music'],
    ])
    expect(tracks[0].volumeDb).toBe(-3)
    expect(tracks[1].audioRole).toBe('voice')
    // New tracks, not references into the project the template came from.
    for (const t of tracks) expect(sourceIds).not.toContain(t.id)
    expect(tracks.every((t) => !t.muted && !t.solo && !t.locked && t.clips.length === 0)).toBe(true)
  })

  it('without a template a new project keeps the stock layout', async () => {
    await createProject()
    const tracks = activeSequence(useStore.getState().project).tracks
    expect(tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'A1', 'A2'])
  })
})
