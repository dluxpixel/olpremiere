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

  it('gives the lab build its own folder beside his, since the lab keeps real backups', () => {
    appName = 'OL Premiere Lab'
    expect(withArgv().replace(/\\/g, '/')).toBe('C:/Users/skyle/Documents/OL Premiere Lab Backups')
  })
})
