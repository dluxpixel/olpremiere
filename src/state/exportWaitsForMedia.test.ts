/**
 * @vitest-environment jsdom
 *
 * An export waits for the media being put back, instead of failing on it.
 *
 * MEASURED 2026-10-01 on a fresh profile, the state after a wipe: Export
 * pressed 10 s after opening mc night said "Media for 2026-09-20 14-12-28.mp4
 * is missing from local storage, re-import it and try again", while the
 * put-back from the spare copies had 11 s left to run. Re-importing was the
 * wrong advice: it makes new assets, and none of his cuts point at them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type Project } from '../engine/types'
import { requestExport, useExportJob } from './exportJob'

const h = vi.hoisted(() => ({
  native: [] as Project[],
  healing: false,
  heals: 0,
  finishHeal: (() => {}) as () => void,
  toasts: [] as string[],
}))

vi.mock('../platform', () => ({ isElectron: true, olApi: undefined }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => h.toasts.push(m) }) } }))
vi.mock('../engine/export/nativeExport', () => ({
  exportNative: (project: Project) => {
    h.native.push(project)
    return new Promise(() => {})
  },
}))
vi.mock('../engine/export', () => ({ canStreamToDisk: () => true, pickExportDestination: () => null, exportSequence: () => null }))
// The spare copies, stood in for: a put-back that runs until the test lets it end.
vi.mock('./mediaMirror', () => ({
  mirrorApi: () => ({}),
  isHealing: () => h.healing,
  healProjectMedia: () => {
    h.heals++
    return new Promise((resolve) => {
      h.finishHeal = () => {
        h.healing = false
        resolve({ healed: ['2026-09-20 14-12-28.mp4'], lost: [] })
      }
    })
  },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

function mcNight(): Project {
  const p = newProject('mc night')
  const seq = activeSequence(p)
  p.assets = { a1: { id: 'a1', name: '2026-09-20 14-12-28.mp4', kind: 'video', blobKey: 'asset/a1', durationS: 5 } as Project['assets'][string] }
  seq.durationS = 5
  seq.tracks[0].clips = [{ id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 5, speed: 1, enabled: true } as unknown as Clip]
  return p
}

beforeEach(() => {
  h.native = []
  h.heals = 0
  h.toasts = []
  useExportJob.setState({ job: null, dialogOpen: false, alreadyRunning: false })
})

describe('Export while his media is still being put back', () => {
  it('waits for it, says so, and then exports', async () => {
    h.healing = true
    requestExport(mcNight())
    await flush()
    // Not a byte read yet, and not a failure either.
    expect(h.native).toHaveLength(0)
    expect(useExportJob.getState().job?.stage.kind).toBe('running')
    expect(h.toasts).toEqual(['Your media is still being put back. The export starts as soon as it is'])
    h.finishHeal()
    await flush()
    expect(h.native).toHaveLength(1)
  })

  it('with nothing being put back it still asks once, quietly, before reading', async () => {
    h.healing = false
    requestExport(mcNight())
    await flush()
    expect(h.heals).toBe(1)
    expect(h.toasts).toEqual([])
    h.finishHeal()
    await flush()
    expect(h.native).toHaveLength(1)
  })
})
