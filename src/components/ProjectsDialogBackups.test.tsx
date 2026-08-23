/**
 * @vitest-environment jsdom
 *
 * THE RECOVER SHELF, rendered.
 *
 * The state layer is covered in backupRestore.test.ts. What cannot be reached
 * from there is the half that actually failed him: whether the copies on his
 * disk are REACHABLE from the app at all. Between July and 2026-08-19 they were
 * written faithfully every couple of minutes and there was no way to open one,
 * which is why an evening's work looked gone when it was sitting in a folder.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'
import { useStore } from '../state/store'
import { ProjectsDialog } from './ProjectsDialog'

const restored: string[] = []
vi.mock('../state/backupRestore', async () => {
  const real = await vi.importActual<typeof import('../state/backupRestore')>('../state/backupRestore')
  return {
    ...real,
    restoreBackup: (path: string) => {
      restored.push(path)
      return Promise.resolve(true)
    },
  }
})
vi.mock('../state/persistence', async () => {
  const real = await vi.importActual<typeof import('../state/persistence')>('../state/persistence')
  return { ...real, listProjects: () => Promise.resolve([]) }
})

const BACKUP = JSON.stringify({
  kind: 'ol-premiere-backup',
  version: 1,
  savedAt: '',
  appVersion: 'desktop',
  project: {
    id: 'p1',
    name: 'Pear',
    createdAt: 1,
    updatedAt: 2,
    assets: { a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'b1', durationS: 5 } },
    sequences: {
      s1: {
        id: 's1',
        name: 'Sequence 1',
        fps: 30,
        width: 1920,
        height: 1080,
        durationS: 5,
        markers: [],
        tracks: [
          {
            id: 't1',
            kind: 'video',
            name: 'V1',
            clips: [
              { id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 3, speed: 1, effects: [] },
              { id: 'c2', assetId: 'a1', startS: 3, inS: 0, outS: 3, speed: 1, effects: [] },
            ],
          },
        ],
      },
    },
    activeSequenceId: 's1',
  },
  mediaNames: { a1: 'clip.mp4' },
})

let revealed = 0

beforeEach(() => {
  restored.length = 0
  revealed = 0
  useStore.getState().setProject(newProject())
  ;(window as unknown as { api: unknown }).api = {
    isElectron: true,
    backupList: () =>
      Promise.resolve([
        { name: '2026-08-19_2032-25_Untitled Project.olpbak', path: 'C:/b/one.olpbak', sizeBytes: 90207, modifiedMs: Date.now() },
      ]),
    backupRead: () => Promise.resolve(BACKUP),
    backupReveal: () => {
      revealed += 1
      return Promise.resolve()
    },
  }
})

afterEach(cleanup)

describe('the Recover shelf', () => {
  it('lists what is on his disk, with enough detail to pick the right one', async () => {
    render(<ProjectsDialog onClose={() => undefined} view="backups" />)
    const row = await screen.findByTestId('backup-row')
    expect(row.textContent).toContain('Pear')
    // The counts are the point: forty near-identical file names say nothing.
    await waitFor(() => expect(row.textContent).toContain('2 clips'))
    expect(row.textContent).toContain('1 media')
  })

  it('recovers the one he picks', async () => {
    render(<ProjectsDialog onClose={() => undefined} view="backups" />)
    await screen.findByTestId('backup-row')
    await waitFor(() => expect((screen.getByTestId('backup-recover') as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(screen.getByTestId('backup-recover'))
    expect(restored).toEqual(['C:/b/one.olpbak'])
  })

  it('opens the folder, because those files are his and not the app to keep', async () => {
    render(<ProjectsDialog onClose={() => undefined} view="backups" />)
    await screen.findByTestId('backup-row')
    await userEvent.click(screen.getByTestId('backups-reveal'))
    expect(revealed).toBe(1)
  })

  // ⛔ HIS CALL, 2026-08-23: *"you better remove the fucking recover tab
  // entirely."* This test used to assert the opposite, that an empty project list
  // OFFERS the way there. It was written for a man who wanted to browse his
  // backups; he had just spent a week losing work to a list of forty rows all
  // called "Untitled Project", and being pointed at that lottery is not help.
  //
  // The tab and the link are gone. `restoreBackup` and the files are NOT: what
  // was removed is the door, not the data.
  it('never offers the recover list, not from the tabs and not from an empty shelf', async () => {
    render(<ProjectsDialog onClose={() => undefined} />)
    await screen.findByTestId('projects-dialog')
    expect(screen.queryByTestId('projects-missing')).toBeNull()
    expect(screen.queryByRole('button', { name: /recover/i })).toBeNull()
    expect(screen.queryByTestId('backup-row')).toBeNull()
  })
})
