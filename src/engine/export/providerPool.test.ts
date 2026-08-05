import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_LIVE_PROVIDERS,
  PROVIDER_REAP_MARGIN_S,
  ProviderPool,
  providerDeadAfterS,
  type PooledClipTiming,
} from './providerPool'

/** A stand-in for the demuxer + decoder pair, so the pool can be driven without WebCodecs. */
interface FakeProvider {
  id: string
}

interface FakeClip extends PooledClipTiming {
  id: string
}

const forever = (id: string): FakeClip => ({ id, startS: 0, inS: 0, outS: 1000, speed: 1 })

/** Clip timings for a track cut into `count` pieces of `cutS` each, from 0. */
function cutTimeline(count: number, cutS: number): FakeClip[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    startS: i * cutS,
    inS: 0,
    outS: cutS,
    speed: 1,
  }))
}

/**
 * Runs a forward export sweep over `clips` at `fps`, reading exactly the one clip
 * that is live at each output time, and reports the worst live provider count.
 * This is the shape of gatherTextures plus the frame loop in exportWorker.
 */
function sweep(
  clips: FakeClip[],
  fps: number,
  maxLive: number,
): { peakLive: number; opens: number; reopens: number; closes: Map<string, number> } {
  const closes = new Map<string, number>()
  const pool = new ProviderPool<FakeProvider>({
    maxLive,
    close: (p) => closes.set(p.id, (closes.get(p.id) ?? 0) + 1),
  })
  const last = clips[clips.length - 1]
  const endS = last.startS + last.outS
  let peakLive = 0
  let opens = 0
  for (let f = 0; f < Math.ceil(endS * fps); f++) {
    const t = f / fps
    pool.beginFrame()
    pool.reap(t)
    const clip = clips.find((c) => t >= c.startS && t < c.startS + c.outS)
    if (clip && !pool.get(clip.id)) {
      pool.set(clip.id, clip, { id: clip.id })
      opens++
    }
    peakLive = Math.max(peakLive, pool.size)
  }
  const reopens = pool.reopens
  pool.clear()
  return { peakLive, opens, reopens, closes }
}

describe('providerDeadAfterS', () => {
  it('is the clip end plus the transition margin', () => {
    const clip: PooledClipTiming = { startS: 4, inS: 0, outS: 2, speed: 1 }
    expect(providerDeadAfterS(clip)).toBe(6 + PROVIDER_REAP_MARGIN_S)
  })

  it('stretches a slowed clip and shrinks a sped-up one', () => {
    // 2s of source at half speed occupies 4s of output.
    expect(providerDeadAfterS({ startS: 0, inS: 0, outS: 2, speed: 0.5 })).toBe(4 + PROVIDER_REAP_MARGIN_S)
    expect(providerDeadAfterS({ startS: 0, inS: 0, outS: 2, speed: 2 })).toBe(1 + PROVIDER_REAP_MARGIN_S)
  })

  it('reads a reversed clip by its absolute speed, not a negative duration', () => {
    expect(providerDeadAfterS({ startS: 0, inS: 0, outS: 2, speed: -1 })).toBe(2 + PROVIDER_REAP_MARGIN_S)
  })

  it('treats a zero speed as 1x instead of dividing by zero', () => {
    expect(providerDeadAfterS({ startS: 0, inS: 0, outS: 2, speed: 0 })).toBe(2 + PROVIDER_REAP_MARGIN_S)
  })
})

describe('ProviderPool ceiling', () => {
  // THE BUG. The old policy was the 10s margin alone, so the live decoder count
  // was 10 divided by the cut length: about 21 at half-second cuts and about 41
  // at quarter-second cuts. Remove the ceiling and this goes red at 21.
  it('holds at most the ceiling on a half-second-cut timeline', () => {
    const { peakLive } = sweep(cutTimeline(120, 0.5), 30, DEFAULT_MAX_LIVE_PROVIDERS)
    expect(peakLive).toBeLessThanOrEqual(DEFAULT_MAX_LIVE_PROVIDERS)
  })

  it('holds at the same ceiling when the cuts get twice as dense', () => {
    const quarter = sweep(cutTimeline(240, 0.25), 30, DEFAULT_MAX_LIVE_PROVIDERS)
    const half = sweep(cutTimeline(120, 0.5), 30, DEFAULT_MAX_LIVE_PROVIDERS)
    // The whole point: the live count stops tracking the cut density.
    expect(quarter.peakLive).toBe(half.peakLive)
    expect(quarter.peakLive).toBeLessThanOrEqual(DEFAULT_MAX_LIVE_PROVIDERS)
  })

  it('costs nothing on a forward sweep: no clip is ever re-opened', () => {
    const { opens, reopens } = sweep(cutTimeline(120, 0.5), 30, DEFAULT_MAX_LIVE_PROVIDERS)
    expect(reopens).toBe(0)
    expect(opens).toBe(120) // one open per clip, exactly as before
  })

  it('closes every provider it opened, exactly once', () => {
    const { closes } = sweep(cutTimeline(40, 0.5), 30, DEFAULT_MAX_LIVE_PROVIDERS)
    expect(closes.size).toBe(40)
    expect([...closes.values()].every((n) => n === 1)).toBe(true)
  })

  it('evicts the least recently used, not the newest', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ maxLive: 2, close: (p) => closed.push(p.id) })
    pool.beginFrame()
    pool.set('a', forever('a'), { id: 'a' })
    pool.beginFrame()
    pool.set('b', forever('b'), { id: 'b' })
    pool.beginFrame()
    pool.get('a') // 'a' is now the most recent, 'b' the stalest
    pool.set('c', forever('c'), { id: 'c' })
    expect(closed).toEqual(['b'])
  })

  it('never evicts a provider the current frame is still reading', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ maxLive: 1, close: (p) => closed.push(p.id) })
    // Both sides of a cross-dissolve gathered inside ONE frame, with a ceiling of 1.
    pool.beginFrame()
    pool.set('from', forever('from'), { id: 'from' })
    pool.set('to', forever('to'), { id: 'to' })
    expect(closed).toEqual([])
    expect(pool.size).toBe(2)
    // The next frame is free to bring it back down to the ceiling.
    pool.beginFrame()
    pool.get('to')
    pool.set('next', forever('next'), { id: 'next' })
    expect(closed).toEqual(['from'])
  })

  it('counts a re-open when the ceiling closed something the sweep came back to', () => {
    const pool = new ProviderPool<FakeProvider>({ maxLive: 1, close: () => undefined })
    pool.beginFrame()
    pool.set('a', forever('a'), { id: 'a' })
    pool.beginFrame()
    pool.set('b', forever('b'), { id: 'b' }) // evicts 'a'
    expect(pool.reopens).toBe(0)
    pool.beginFrame()
    expect(pool.get('a')).toBeUndefined()
    expect(pool.reopens).toBe(1)
  })
})

describe('ProviderPool reaping', () => {
  it('keeps a finished clip alive for the whole transition margin', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ close: (p) => closed.push(p.id) })
    pool.beginFrame()
    pool.set('a', { startS: 0, inS: 0, outS: 2, speed: 1 }, { id: 'a' })
    // A 10s transition into the next clip still samples 'a' past its out point.
    pool.reap(2 + PROVIDER_REAP_MARGIN_S)
    expect(closed).toEqual([])
    pool.reap(2 + PROVIDER_REAP_MARGIN_S + 0.001)
    expect(closed).toEqual(['a'])
  })

  it('reaps on the frame the margin passes, not up to a second later', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ close: (p) => closed.push(p.id) })
    pool.beginFrame()
    pool.set('a', { startS: 0, inS: 0, outS: 1, speed: 1 }, { id: 'a' })
    const fps = 30
    // The old code only reaped on frames where f % round(fps) === 0, so a provider
    // that died at frame 331 stayed open until frame 360.
    const deadAtFrame = Math.floor((1 + PROVIDER_REAP_MARGIN_S) * fps) + 1
    expect(deadAtFrame % fps).not.toBe(0) // the old once-a-second reap would have missed it
    for (let f = 0; f <= deadAtFrame; f++) {
      pool.beginFrame()
      pool.reap(f / fps)
    }
    expect(closed).toEqual(['a'])
  })

  it('clear closes the survivors once, and does nothing on a second call', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ close: (p) => closed.push(p.id) })
    pool.beginFrame()
    pool.set('a', { startS: 0, inS: 0, outS: 5, speed: 1 }, { id: 'a' })
    pool.set('b', { startS: 0, inS: 0, outS: 5, speed: 1 }, { id: 'b' })
    pool.clear()
    expect(closed).toEqual(['a', 'b'])
    pool.clear()
    expect(closed).toEqual(['a', 'b'])
  })

  it('does not close a reaped provider a second time at clear', () => {
    const closed: string[] = []
    const pool = new ProviderPool<FakeProvider>({ close: (p) => closed.push(p.id) })
    pool.beginFrame()
    pool.set('a', { startS: 0, inS: 0, outS: 1, speed: 1 }, { id: 'a' })
    pool.reap(100)
    pool.clear()
    expect(closed).toEqual(['a'])
  })
})
