// How a backup reaches the disk.
//
// ⛔ BESIDE ITS NAME FIRST, THEN RENAMED OVER. Written straight to its name, a
// crash, a power cut or a full disk (his is 97% full) left a torn backup. One
// with no id in it is never pruned, because a backup it cannot read stays, and
// the spare copy cleanup, which must read every backup, stopped for good. Worse,
// two backups of one project in the same second share a name, so a torn second
// write tore the good first one too.
// Real files in a temp folder; only the write that dies half way is staged.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', dieHalfWay: false }))

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (!env.dieHalfWay) return real.writeFile(...args)
      env.dieHalfWay = false
      // Half the bytes are down, and the rest never come.
      const [file, data, opts] = args
      await real.writeFile(file, String(data).slice(0, 12), opts)
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    },
  }
})
// The lab build keeps its backups inside its own profile: here, a temp folder.
vi.mock('electron', () => ({
  app: { getName: () => 'OL Premiere Lab', getPath: () => env.root },
}))

const { backupDir, writeBackup } = await import('./backups')

const backupOf = (id: string, name: string): string =>
  JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id, name, assets: {}, sequences: {} } })

beforeEach(async () => {
  env.root = await mkdtemp(path.join(tmpdir(), 'olp-backup-'))
  env.dieHalfWay = false
  // One second for every write, so two backups of one project share a name, as
  // they do when the whole shelf is written in one go.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(env.root, { recursive: true, force: true })
})

describe('⛔ a backup write that dies half way', () => {
  it('leaves no torn backup, and never tears the one already under that name', async () => {
    const good = backupOf('gym-1', 'GYM')
    const first = await writeBackup('GYM', good)
    env.dieHalfWay = true
    await expect(writeBackup('GYM', backupOf('gym-1', 'GYM again'))).rejects.toThrow(/ENOSPC/)

    const names = await readdir(backupDir())
    // Every backup there reads whole, and the good one is exactly as written.
    for (const n of names.filter((f) => f.endsWith('.olpbak'))) {
      expect(JSON.parse(await readFile(path.join(backupDir(), n), 'utf8')).project.id).toBe('gym-1')
    }
    expect(await readFile(first, 'utf8')).toBe(good)
    // Nor a part file left behind for each failed try.
    expect(names.filter((f) => !f.endsWith('.olpbak'))).toEqual([])
  })

  it('a write that goes through still lands whole under its name', async () => {
    const json = backupOf('green-1', 'Green')
    const file = await writeBackup('Green', json)
    expect(await readFile(file, 'utf8')).toBe(json)
    expect(await readdir(backupDir())).toEqual([path.basename(file)])
  })
})
