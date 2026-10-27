// The reel plan validator: a sound plan passes, and every kind of bad plan is refused
// with ALL its problems listed, not just the first.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseReelPlan, REEL_SAFE_RECT, validateReelPlan } from './reelPlan'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureText = readFileSync(path.join(here, 'fixtures', 'reel-plan.json'), 'utf8')
/** A fresh copy of the good plan, ready to be damaged. */
const good = () => JSON.parse(fixtureText)

function problemsOf(plan: unknown): string[] {
  const r = validateReelPlan(plan)
  if (r.ok) throw new Error('expected the plan to be refused')
  return r.problems
}

describe('the safe rect', () => {
  it('is the one agreed constant', () => {
    expect([...REEL_SAFE_RECT]).toEqual([60, 250, 900, 1250])
  })
})

describe('a good plan', () => {
  it('passes and comes back typed', () => {
    const r = validateReelPlan(good())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.timeline).toHaveLength(4)
      expect(r.plan.clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    }
  })

  it('passes from the text of the file, byte order mark and all', () => {
    expect(parseReelPlan(fixtureText).ok).toBe(true)
    expect(parseReelPlan(String.fromCharCode(0xfeff) + fixtureText).ok).toBe(true)
  })

  it('allows a title that fills the safe rect exactly', () => {
    const p = good()
    p.titles[0].box = [60, 250, 900, 1250]
    expect(validateReelPlan(p).ok).toBe(true)
  })

  it('allows no titles, no captions and a plan without a source', () => {
    const p = good()
    p.titles = []
    p.captions = []
    delete p.source
    expect(validateReelPlan(p).ok).toBe(true)
  })

  it('allows a shot that ends a hair past the duration (rounding)', () => {
    const p = good()
    p.duration = 14.1996
    expect(validateReelPlan(p).ok).toBe(true)
  })
})

describe('a bad plan is refused', () => {
  it('a file that is not JSON, and JSON that is not a plan', () => {
    expect(parseReelPlan('{nope')).toEqual({ ok: false, problems: ['The file is not valid JSON.'] })
    expect(problemsOf([])).toEqual(['The plan must be a JSON object.'])
    expect(problemsOf(null)).toEqual(['The plan must be a JSON object.'])
  })

  it('the wrong version or format', () => {
    const p = good()
    p.version = 2
    p.format = '16:9'
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('version must be 1'))).toBe(true)
    expect(probs.some((m) => m.startsWith('format must be "9:16"'))).toBe(true)
  })

  it('a timeline shot that names a clip that is not in clips', () => {
    const p = good()
    p.timeline[1].clip = 'c9'
    const probs = problemsOf(p)
    expect(probs).toHaveLength(1)
    expect(probs[0]).toContain('timeline[1]')
    expect(probs[0]).toContain('"c9"')
  })

  it('a title box outside the safe rect, on each side', () => {
    for (const box of [
      [40, 300, 500, 300], // left of x 60
      [100, 200, 500, 300], // above y 250
      [600, 300, 400, 300], // runs past x 960
      [100, 1300, 500, 300], // runs past y 1500
    ]) {
      const p = good()
      p.titles[0].box = box
      const probs = problemsOf(p)
      expect(probs).toHaveLength(1)
      expect(probs[0]).toContain('titles[0]')
      expect(probs[0]).toContain('outside the safe rect')
    }
  })

  it('a title box that is not four numbers, or has no size', () => {
    const p = good()
    p.titles[0].box = [100, 300, 500]
    p.titles[1].box = [100, 300, 0, 200]
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('titles[0]') && m.includes('four numbers'))).toBe(true)
    expect(probs.some((m) => m.startsWith('titles[1]') && m.includes('above 0'))).toBe(true)
  })

  it('bad shot times: src_out not above src_in, src_in below 0, at below 0', () => {
    const p = good()
    p.timeline[0].src_out = p.timeline[0].src_in
    p.timeline[1].src_in = -1
    p.timeline[2].at = -2
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('timeline[0]') && m.includes('src_out'))).toBe(true)
    expect(probs.some((m) => m.startsWith('timeline[1]') && m.includes('src_in must be 0 or more'))).toBe(true)
    expect(probs.some((m) => m.startsWith('timeline[2]') && m.includes('at must be 0 or more'))).toBe(true)
  })

  it('a timeline that is out of order', () => {
    const p = good()
    const [a, b] = [p.timeline[1], p.timeline[2]]
    p.timeline[1] = b
    p.timeline[2] = a
    const probs = problemsOf(p)
    expect(probs.some((m) => m.includes('sorted by at'))).toBe(true)
  })

  it('shots that overlap', () => {
    const p = good()
    p.timeline[1].at = 1.0 // shot 0 runs to 1.7
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('timeline[1]') && m.includes('overlap'))).toBe(true)
  })

  it('a timeline that runs past the duration', () => {
    const p = good()
    p.duration = 10
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('timeline[3]') && m.includes('past the plan duration'))).toBe(true)
  })

  it('a title or caption with no length, and a duration of 0', () => {
    const p = good()
    p.titles[0].dur = 0
    p.captions[1].dur = -0.1
    p.duration = 0
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('titles[0]') && m.includes('dur must be above 0'))).toBe(true)
    expect(probs.some((m) => m.startsWith('captions[1]') && m.includes('dur must be above 0'))).toBe(true)
    expect(probs).toContain('duration must be a number above 0.')
  })

  it('duplicate clip ids and an empty path', () => {
    const p = good()
    p.clips[1].id = 'c1'
    p.clips[2].path = '  '
    const probs = problemsOf(p)
    expect(probs.some((m) => m.startsWith('clips[1]') && m.includes('used twice'))).toBe(true)
    expect(probs.some((m) => m.startsWith('clips[2]') && m.includes('path'))).toBe(true)
  })

  it('a missing section, an empty timeline, bad audio', () => {
    const p = good()
    delete p.clips
    p.timeline = []
    p.audio = { music: 5, beats: ['x'], keep_clip_audio: 'yes' }
    const probs = problemsOf(p)
    expect(probs).toContain('clips must be a list.')
    expect(probs.some((m) => m.includes('no shots'))).toBe(true)
    expect(probs).toContain('audio.music must be a file path or null.')
    expect(probs).toContain('audio.beats must be a list of times in seconds.')
    expect(probs).toContain('audio.keep_clip_audio must be true or false.')
  })

  it('lists EVERY problem, not just the first', () => {
    const p = good()
    p.version = 3
    p.timeline[0].clip = 'ghost'
    p.timeline[2].src_out = 1
    p.titles[1].box = [0, 0, 100, 100]
    p.titles[2].dur = 0
    p.captions[0].dur = 0
    const probs = problemsOf(p)
    expect(probs.length).toBeGreaterThanOrEqual(6)
    for (const where of ['version', 'timeline[0]', 'timeline[2]', 'titles[1]', 'titles[2]', 'captions[0]']) {
      expect(probs.some((m) => m.startsWith(where))).toBe(true)
    }
  })

  it('never echoes a long value in full', () => {
    const p = good()
    p.timeline[0].clip = 'x'.repeat(5000)
    const probs = problemsOf(p)
    expect(probs[0].length).toBeLessThan(200)
  })

  it('writes no em dash or en dash into a message', () => {
    const p = good()
    p.version = 9
    p.titles[0].box = [0, 0, 5, 5]
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)
    for (const m of problemsOf(p)) expect(m).not.toMatch(dashes)
  })
})
