// A reel plan in main: the dialog, the read, the check, and the clips on disk. Real
// files in a throwaway folder; only the file dialog is faked.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** What the fake file dialog answers, and what it was asked. */
  answer: { canceled: false, filePaths: [] as string[] },
  asked: [] as unknown[],
}))
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async (...args: unknown[]) => {
      h.asked.push(args[args.length - 1])
      return h.answer
    },
  },
}))

const root = mkdtempSync(path.join(tmpdir(), 'olp-reel-plan-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const { importReelPlan, readReelClip } = await import('./reelPlanFile')

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = () => JSON.parse(readFileSync(path.join(here, 'fixtures', 'reel-plan.json'), 'utf8'))

let dir = ''
/** The fixture plan with its clips written for real into this test's folder. */
function writePlan(edit?: (plan: ReturnType<typeof fixture>) => void): string {
  const plan = fixture()
  for (const c of plan.clips) {
    const real = path.join(dir, path.basename(c.path))
    writeFileSync(real, Buffer.from(`bytes of ${c.id}`))
    c.path = real.replace(/\\/g, '/')
  }
  edit?.(plan)
  const file = path.join(dir, 'reel-plan.json')
  writeFileSync(file, JSON.stringify(plan))
  return file
}

beforeEach(() => {
  dir = mkdtempSync(path.join(root, 'plan-'))
  h.asked = []
  h.answer = { canceled: false, filePaths: [] }
})

describe('importing a reel plan', () => {
  it('opens a dialog that takes a .json, and hands back the plan and its clip files', async () => {
    h.answer = { canceled: false, filePaths: [writePlan()] }
    const r = await importReelPlan(null)
    expect(r.status).toBe('plan')
    if (r.status !== 'plan') return
    expect(r.plan.timeline).toHaveLength(4)
    expect(r.fileName).toBe('reel-plan.json')
    expect(r.files.map((f) => f.id)).toEqual(['c1', 'c2', 'c3'])
    expect(r.files[0]).toMatchObject({ name: 'IMG_4410.MOV', size: 'bytes of c1'.length, mime: 'video/quicktime' })
    expect(r.files[2].mime).toBe('video/mp4')
    const asked = h.asked[0] as { filters: { extensions: string[] }[] }
    expect(asked.filters[0].extensions).toEqual(['json'])
  })

  it('takes a path instead of asking', async () => {
    const r = await importReelPlan(null, writePlan())
    expect(r.status).toBe('plan')
    expect(h.asked).toHaveLength(0)
  })

  it('a dismissed dialog is cancelled, not an error', async () => {
    h.answer = { canceled: true, filePaths: [] }
    expect(await importReelPlan(null)).toEqual({ status: 'cancelled' })
  })

  it('refuses the WHOLE plan when a clip is missing, and names it by its path', async () => {
    let gone = ''
    const file = writePlan((p) => {
      gone = path.join(dir, 'nope', 'IMG_9999.MOV').replace(/\\/g, '/')
      p.clips[1].path = gone
    })
    const r = await importReelPlan(null, file)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain(gone)
    expect(r.problems[0]).toContain('clips[1]')
  })

  it('names every missing clip, not just the first', async () => {
    const file = writePlan((p) => {
      p.clips[0].path = path.join(dir, 'a.mov').replace(/\\/g, '/')
      p.clips[2].path = path.join(dir, 'b.mp4').replace(/\\/g, '/')
    })
    const r = await importReelPlan(null, file)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.problems).toHaveLength(2)
  })

  it('refuses a plan the validator refuses, with all its problems', async () => {
    const file = writePlan((p) => {
      p.titles[0].box = [0, 0, 10, 10]
      p.timeline[0].clip = 'ghost'
    })
    const r = await importReelPlan(null, file)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.problems.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses a file that is not JSON, and a path that is not a .json', async () => {
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(await importReelPlan(null, bad)).toEqual({ status: 'refused', problems: ['The file is not valid JSON.'] })
    const txt = path.join(dir, 'plan.txt')
    writeFileSync(txt, '{}')
    expect((await importReelPlan(null, txt)).status).toBe('refused')
    expect((await importReelPlan(null, path.join(dir, 'missing.json'))).status).toBe('refused')
  })

  it('refuses a clip that is a relative path or not a video', async () => {
    const rel = await importReelPlan(
      null,
      writePlan((p) => {
        p.clips[0].path = 'IMG_4410.MOV'
      }),
    )
    expect(rel.status).toBe('refused')
    const notVideo = await importReelPlan(
      null,
      writePlan((p) => {
        const secret = path.join(dir, 'notes.txt')
        writeFileSync(secret, 'x')
        p.clips[0].path = secret.replace(/\\/g, '/')
      }),
    )
    expect(notVideo.status).toBe('refused')
    if (notVideo.status === 'refused') expect(notVideo.problems[0]).toContain('notes.txt')
  })

  it('refuses a plan file that is far too big to be one', async () => {
    const big = path.join(dir, 'big.json')
    writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 0x20))
    expect((await importReelPlan(null, big)).status).toBe('refused')
  })
})

describe('reading a clip back', () => {
  const bytes = async (id: string, offset: number, length: number): Promise<string> =>
    Buffer.from(await readReelClip(id, offset, length)).toString()

  it('streams a clip of the plan that passed', async () => {
    await importReelPlan(null, writePlan())
    expect(await bytes('c1', 0, 'bytes of c1'.length)).toBe('bytes of c1')
    expect(await bytes('c2', 9, 2)).toBe('c2')
  })

  it('refuses an id the plan did not name, and a range outside the clip', async () => {
    await importReelPlan(null, writePlan())
    await expect(readReelClip('c9', 0, 1)).rejects.toThrow(/Refused/)
    await expect(readReelClip('c1', 0, 999)).rejects.toThrow(/Refused/)
    await expect(readReelClip('c1', -1, 2)).rejects.toThrow(/Refused/)
    await expect(readReelClip('c1', 0, 0)).rejects.toThrow(/Refused/)
    await expect(readReelClip('c1', 0.5, 2)).rejects.toThrow(/Refused/)
    await expect(readReelClip({ not: 'a string' }, 0, 1)).rejects.toThrow(/Refused/)
  })

  it('forgets the clips of an earlier plan once a plan is refused', async () => {
    await importReelPlan(null, writePlan())
    await expect(readReelClip('c1', 0, 1)).resolves.toBeInstanceOf(ArrayBuffer)
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    await importReelPlan(null, bad)
    await expect(readReelClip('c1', 0, 1)).rejects.toThrow(/Refused/)
  })

  it('serves only the clips of the newest plan', async () => {
    await importReelPlan(null, writePlan())
    const second = writePlan((p) => {
      p.clips = p.clips.slice(0, 1)
      p.timeline = p.timeline.filter((s: { clip: string }) => s.clip === 'c1')
    })
    expect((await importReelPlan(null, second)).status).toBe('plan')
    await expect(readReelClip('c2', 0, 1)).rejects.toThrow(/Refused/)
    await expect(readReelClip('c1', 0, 1)).resolves.toBeInstanceOf(ArrayBuffer)
  })
})
