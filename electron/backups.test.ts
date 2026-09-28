// Which folder the automatic backups go in.
//
// ⛔ THE ONE RULE: HIS FOLDER IS WRITTEN BY HIS APP AND BY NOTHING ELSE.
//
// The backups rotate, forty kept. So anything else writing into that folder is
// not just adding clutter, it is DELETING his oldest copy every time it writes.
// On 2026-08-19 roughly half of what was left in there had been written by a
// caption test harness, because `--user-data-dir` moves the saved projects
// somewhere disposable and does not move Documents. A safety net a test run can
// empty is not a safety net.

import { beforeEach, describe, expect, it, vi } from 'vitest'

let appName = 'OL Premiere'
const paths: Record<string, string> = { documents: 'C:/Users/skyle/Documents', userData: 'C:/profile' }

vi.mock('electron', () => ({
  app: {
    getName: () => appName,
    getPath: (k: string) => paths[k],
  },
}))

const { backupDir } = await import('./backups')

const withArgv = (...extra: string[]): string => {
  const real = process.argv
  process.argv = ['electron.exe', '.', ...extra]
  try {
    return backupDir()
  } finally {
    process.argv = real
  }
}

beforeEach(() => {
  appName = 'OL Premiere'
})

describe('the backup folder', () => {
  it('is his Documents folder for his app, and that never moves', () => {
    expect(withArgv().replace(/\\/g, '/')).toBe('C:/Users/skyle/Documents/OL Premiere Backups')
  })

  it('follows a throwaway profile, so a test run can never rotate his copies away', () => {
    const dir = withArgv('--user-data-dir=C:/tmp/probe').replace(/\\/g, '/')
    expect(dir).toBe('C:/profile/Backups')
    expect(dir).not.toContain('Documents')
  })

  it('keeps the lab build out of his Documents entirely, folder and all', () => {
    appName = 'OL Premiere Lab'
    const dir = withArgv().replace(/\\/g, '/')
    expect(dir).toBe('C:/profile/Backups')
    expect(dir).not.toContain('Documents')
  })
})

describe('reading a backup id without parsing the whole file', () => {
  it('finds the id in the head exactly where the serializer puts it', async () => {
    const { idFromHead } = await import('./backups')
    const { serialize } = await import('../src/state/backupFormat')
    const json = serialize({ id: 'abc-123', name: 'Green', assets: {}, sequences: {} } as never, 'desktop')
    expect(idFromHead(json.slice(0, 1024))).toBe('abc-123')
  })

  it('says nothing rather than guessing when the head does not hold it', async () => {
    const { idFromHead } = await import('./backups')
    expect(idFromHead('{"kind":"ol-premiere-backup","project":{"name":"x","id":"late"}}')).toBeNull()
    expect(idFromHead('not json at all')).toBeNull()
  })
})
