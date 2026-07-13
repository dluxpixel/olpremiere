// The collab undo guarantee: in a room, undo reverts ONLY your own last
// command — edits other people made since (which plain snapshot-undo would
// silently wipe) survive. Exercises the real store + the real rebase.

import { beforeEach, describe, expect, it } from 'vitest'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'
import { useStore } from '../state/store'
import { rebasedHistoryStep } from './session'

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})

function seedProject(): Project {
  const p = newProject('Rebase Test')
  p.assets.a1 = asset('a1')
  const seq = p.sequences[p.activeSequenceId]
  seq.tracks.find((t) => t.kind === 'video')!.clips.push({ ...newClipFromAsset(asset('a1'), 0), id: 'c1' })
  seq.durationS = 4
  return p
}

const videoClips = (p: Project) =>
  p.sequences[p.activeSequenceId].tracks.find((t) => t.kind === 'video')!.clips

beforeEach(() => {
  useStore.getState().setProject(seedProject())
  useStore.getState().setUI({ selection: [] })
})

describe('rebasedHistoryStep', () => {
  it('undo reverts my command but keeps a remote edit made after it', () => {
    const store = useStore.getState()

    // MY edit (undoable): move c1 to t=5.
    store.dispatch('Move clip', (p) => {
      const next = structuredClone(p)
      videoClips(next).find((c) => c.id === 'c1')!.startS = 5
      return next
    })
    expect(videoClips(useStore.getState().project)[0].startS).toBe(5)

    // A REMOTE edit arrives afterwards: someone adds c2 (no history entry).
    const remote = structuredClone(useStore.getState().project)
    videoClips(remote).push({ ...newClipFromAsset(asset('a1'), 8), id: 'c2' })
    useStore.getState().applyRemoteProject(remote)
    expect(videoClips(useStore.getState().project)).toHaveLength(2)

    // Rebased undo: c1 returns to 0, c2 SURVIVES (snapshot undo would kill it).
    const label = rebasedHistoryStep('undo')
    expect(label).toBe('Move clip')
    const clips = videoClips(useStore.getState().project)
    expect(clips).toHaveLength(2)
    expect(clips.find((c) => c.id === 'c1')!.startS).toBe(0)
    expect(clips.some((c) => c.id === 'c2')).toBe(true)
  })

  it('redo re-applies my command, still keeping the remote edit', () => {
    const store = useStore.getState()
    store.dispatch('Move clip', (p) => {
      const next = structuredClone(p)
      videoClips(next).find((c) => c.id === 'c1')!.startS = 5
      return next
    })
    const remote = structuredClone(useStore.getState().project)
    videoClips(remote).push({ ...newClipFromAsset(asset('a1'), 8), id: 'c2' })
    useStore.getState().applyRemoteProject(remote)

    rebasedHistoryStep('undo')
    const label = rebasedHistoryStep('redo')
    expect(label).toBe('Move clip')
    const clips = videoClips(useStore.getState().project)
    expect(clips.find((c) => c.id === 'c1')!.startS).toBe(5) // re-applied
    expect(clips.some((c) => c.id === 'c2')).toBe(true) // remote work intact
  })

  it('returns null on an empty stack and leaves the project alone', () => {
    const before = useStore.getState().project
    expect(rebasedHistoryStep('undo')).toBeNull()
    expect(useStore.getState().project).toBe(before)
  })

  it('does NOT drag project meta along: a clip undo leaves a remote rename/settings change alone', () => {
    const store = useStore.getState()
    // My clip edit (meta.updatedAt bumps — the trap).
    store.dispatch('Move clip', (p) => {
      const next = structuredClone(p)
      videoClips(next).find((c) => c.id === 'c1')!.startS = 5
      return next
    })
    // Remote: someone renames the project and switches to 9:16.
    const remote = structuredClone(useStore.getState().project)
    remote.name = 'Renamed by peer'
    remote.settings = { ...remote.settings, width: 1080, height: 1920 }
    useStore.getState().applyRemoteProject(remote)

    rebasedHistoryStep('undo')
    const p = useStore.getState().project
    expect(videoClips(p).find((c) => c.id === 'c1')!.startS).toBe(0) // my edit reverted
    expect(p.name).toBe('Renamed by peer') // their rename SURVIVES
    expect(p.settings.width).toBe(1080) // their format switch SURVIVES
  })

  it('meta changes the command GENUINELY made still revert (project rename undo)', () => {
    const store = useStore.getState()
    store.dispatch('Rename project', (p) => ({ ...p, name: 'New Name' }))
    expect(useStore.getState().project.name).toBe('New Name')
    rebasedHistoryStep('undo')
    expect(useStore.getState().project.name).toBe('Rebase Test')
  })

  it('discards commands recorded against a DIFFERENT project (pre-join stack)', () => {
    const store = useStore.getState()
    // A command on MY project…
    store.dispatch('Move clip', (p) => {
      const next = structuredClone(p)
      videoClips(next).find((c) => c.id === 'c1')!.startS = 5
      return next
    })
    // …then a room adoption swaps in a different project id. applyRemoteProject
    // clears history on id change; simulate a stale command surviving anyway by
    // re-pushing after adoption is not possible via public API — so instead
    // verify the id-change clears the stack outright.
    const room = seedProject()
    room.id = 'room-project-id'
    room.name = 'Room Project'
    useStore.getState().applyRemoteProject(room)
    expect(useStore.getState().history.undo).toHaveLength(0) // stack cleared on adoption
    expect(rebasedHistoryStep('undo')).toBeNull() // nothing stale to rebase
    expect(useStore.getState().project.id).toBe('room-project-id') // meta intact
  })

  it('contrast: plain snapshot undo WOULD wipe the remote edit', () => {
    const store = useStore.getState()
    store.dispatch('Move clip', (p) => {
      const next = structuredClone(p)
      videoClips(next).find((c) => c.id === 'c1')!.startS = 5
      return next
    })
    const remote = structuredClone(useStore.getState().project)
    videoClips(remote).push({ ...newClipFromAsset(asset('a1'), 8), id: 'c2' })
    useStore.getState().applyRemoteProject(remote)

    useStore.getState().undo() // the OLD behavior
    // The snapshot restore erased the remote clip — the bug the rebase fixes.
    expect(videoClips(useStore.getState().project).some((c) => c.id === 'c2')).toBe(false)
  })
})
