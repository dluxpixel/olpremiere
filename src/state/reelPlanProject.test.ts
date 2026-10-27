// A reel plan, laid out as a project: how many clips, where they sit, when the titles
// come and go, and the size of the frame. Real mapper, fake media.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ReelPlan } from '../../electron/reelPlan'
import { activeSequence, audioTracks, clipEndS, videoTracks, type Clip, type MediaAsset, type Sequence } from '../engine/types'
import { CAPTION_TRACK_NAME } from './captionActions'

// captionActions pulls in the store, which toasts; the mapper never does.
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { applyReelPlan, newReelPlanProject, reelPlanProjectName, reelPlanRefusalMessage, reelTitleLook } = await import(
  './reelPlanProject'
)

const here = path.dirname(fileURLToPath(import.meta.url))
const loadPlan = (): ReelPlan => JSON.parse(readFileSync(path.join(here, '..', '..', 'electron', 'fixtures', 'reel-plan.json'), 'utf8'))

const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  name: `${id}.mov`,
  kind: 'video',
  blobKey: `blob/${id}`,
  durationS: 30,
  width: 1080,
  height: 1920,
  hasAudio: true,
  hasVideo: true,
  ...over,
})
const assetsFor = (plan: ReelPlan, over: Partial<MediaAsset> = {}): Record<string, MediaAsset> =>
  Object.fromEntries(plan.clips.map((c) => [c.id, asset(`a-${c.id}`, over)]))

function build(edit?: (plan: ReelPlan) => void, over: Partial<MediaAsset> = {}) {
  const plan = loadPlan()
  edit?.(plan)
  const project = newReelPlanProject(plan, 'Gym reel')
  const built = applyReelPlan(activeSequence(project), plan, assetsFor(plan, over))
  return { plan, project, ...built }
}

const named = (seq: Sequence, name: string) => seq.tracks.find((t) => t.name === name)
const titleTracks = (seq: Sequence) => videoTracks(seq).filter((t) => t.name !== 'V1' && t.name !== CAPTION_TRACK_NAME)
const titleClips = (seq: Sequence): Clip[] => titleTracks(seq).flatMap((t) => t.clips).sort((a, b) => a.startS - b.startS)

describe('the empty project', () => {
  it('is 9:16 at 1080 by 1920 and the plan frame rate', () => {
    const plan = loadPlan()
    plan.fps = 24
    const p = newReelPlanProject(plan, 'Gym reel')
    const seq = activeSequence(p)
    expect(p.name).toBe('Gym reel')
    expect([seq.width, seq.height]).toEqual([1080, 1920])
    expect(seq.fps).toBe(24)
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, fps: 24 })
  })

  it('is named after the plan file', () => {
    expect(reelPlanProjectName('squat-day.json')).toBe('squat-day')
    expect(reelPlanProjectName('.JSON')).toBe('Reel plan')
  })
})

describe('a refusal in words', () => {
  it('names the problems of a short list in full', () => {
    const m = reelPlanRefusalMessage(['clips[1]: the clip is missing: D:/a.mov'])
    expect(m).toContain('not imported')
    expect(m).toContain('D:/a.mov')
    expect(m).not.toContain('more')
  })

  it('names the first few and counts the rest', () => {
    const m = reelPlanRefusalMessage(['one.', 'two.', 'three.', 'four.', 'five.'])
    expect(m).toContain('three.')
    expect(m).not.toContain('four.')
    expect(m).toContain('And 2 more.')
  })
})

describe('the shots', () => {
  it('puts every shot of the plan on V1, one clip each', () => {
    const { seq } = build()
    const v1 = videoTracks(seq)[0]
    expect(v1.clips).toHaveLength(4)
  })

  it('places each shot at its time with its cut of the source', () => {
    const { seq } = build()
    const clips = videoTracks(seq)[0].clips
    expect(clips.map((c) => c.startS)).toEqual([0, 1.7, 5, 9.2])
    expect(clips.map((c) => c.inS)).toEqual([3.4, 0, 8, 1])
    const lengths = clips.map((c) => +(clipEndS(c) - c.startS).toFixed(6))
    expect(lengths).toEqual([1.7, 3.3, 4.2, 5])
    expect(clips.map((c) => c.assetId)).toEqual(['a-c1', 'a-c2', 'a-c1', 'a-c3'])
  })

  it('leaves no overlap and no wrong order on any track', () => {
    const { seq } = build()
    for (const t of seq.tracks) {
      for (let i = 1; i < t.clips.length; i++) {
        expect(t.clips[i].startS).toBeGreaterThanOrEqual(clipEndS(t.clips[i - 1]) - 1e-6)
      }
    }
  })

  it('makes the sequence as long as the plan', () => {
    const { seq } = build()
    expect(seq.durationS).toBeCloseTo(14.2, 5)
  })

  it('is 9:16 on the sequence it hands back', () => {
    const { seq } = build()
    expect([seq.width, seq.height, seq.fps]).toEqual([1080, 1920, 30])
  })

  it('fills the frame with a picture shot to 9:16 and does not turn it again', () => {
    const { seq } = build()
    for (const c of videoTracks(seq)[0].clips) expect(c.transform.rotationDeg).toBe(0)
  })

  it('snaps a start that falls between frames onto the grid', () => {
    const { seq } = build((p) => {
      p.timeline[1].at = 1.7004
    })
    const c = videoTracks(seq)[0].clips[1]
    expect(Math.abs(c.startS * 30 - Math.round(c.startS * 30))).toBeLessThan(1e-6)
  })
})

describe('cuts that meet', () => {
  // 0.4833 s is frame 14.499 and 0.4834 s is frame 14.502: the same instant to a tenth of
  // a millisecond, one frame apart once each is rounded on its own.
  const twoCuts = (secondAt: number) => (p: ReelPlan) => {
    p.timeline = [
      { clip: 'c1', src_in: 0, src_out: 0.4833, at: 0 },
      { clip: 'c2', src_in: 0, src_out: 2, at: secondAt },
    ]
  }

  it('closes the 1 frame gap that rounding two contiguous cuts apart leaves', () => {
    const { seq } = build(twoCuts(0.4834))
    const [a, b] = videoTracks(seq)[0].clips
    expect(Math.round(clipEndS(a) * 30)).toBe(14)
    expect(Math.round(b.startS * 30)).toBe(14)
    expect(b.startS).toBeCloseTo(clipEndS(a), 9)
    // The sound moves with its picture.
    const [, soundB] = audioTracks(seq)[0].clips
    expect(soundB.startS).toBe(b.startS)
    expect(soundB.outS).toBe(b.outS)
  })

  it('trims the frame that closed the gap without calling the shot cut short', () => {
    // 2 s of media is the 60 frames the plan asks of c2; the closed gap made the shot 61.
    const { seq, warnings } = build(twoCuts(0.4834), { durationS: 2 })
    expect(warnings.some((w) => /cut short/.test(w))).toBe(false)
    const [, b] = videoTracks(seq)[0].clips
    expect(b.outS).toBeLessThanOrEqual(2 + 1e-6)
    // A file really shorter than the plan's out point still says so.
    expect(build(twoCuts(0.4834), { durationS: 1.9 }).warnings.some((w) => /Shot 2 was cut short/.test(w))).toBe(true)
  })

  it('keeps a gap the plan really has', () => {
    // 0.5 s is frame 15 and 16.7 ms after the first cut ends: not contiguous.
    const { seq } = build(twoCuts(0.5))
    const [a, b] = videoTracks(seq)[0].clips
    expect(Math.round(clipEndS(a) * 30)).toBe(14)
    expect(Math.round(b.startS * 30)).toBe(15)
  })
})

describe('the sound of the shots', () => {
  it('links each shot to its own sound on A1', () => {
    const { seq } = build()
    const v = videoTracks(seq)[0].clips
    const a = audioTracks(seq)[0].clips
    expect(a).toHaveLength(4)
    a.forEach((ac, i) => {
      expect(ac.linkId).toBeTruthy()
      expect(ac.linkId).toBe(v[i].linkId)
      expect(ac.startS).toBe(v[i].startS)
      expect(ac.inS).toBe(v[i].inS)
      expect(ac.outS).toBe(v[i].outS)
      expect(ac.assetId).toBe(v[i].assetId)
    })
  })

  it('silences the shots and writes no sound when the plan drops clip audio', () => {
    const { seq } = build((p) => {
      p.audio.keep_clip_audio = false
    })
    expect(audioTracks(seq).every((t) => t.clips.length === 0)).toBe(true)
    for (const c of videoTracks(seq)[0].clips) {
      expect(c.ownAudioOff).toBe(true)
      expect(c.linkId).toBeUndefined()
    }
  })

  it('does not link a shot whose file has no sound', () => {
    const { seq } = build(undefined, { hasAudio: false })
    expect(audioTracks(seq).every((t) => t.clips.length === 0)).toBe(true)
    for (const c of videoTracks(seq)[0].clips) expect(c.linkId).toBeUndefined()
  })
})

describe('shots the media cannot give', () => {
  it('cuts a shot short, with a warning, when the file ends before the out point', () => {
    const { seq, warnings } = build(undefined, { durationS: 4 })
    // With 4 s of media, shots 1 and 4 run past the end (cut short) and shot 3 starts at 8.0 (left out).
    const clips = videoTracks(seq)[0].clips
    expect(warnings.length).toBeGreaterThan(0)
    for (const c of clips) expect(c.outS).toBeLessThanOrEqual(4 + 1e-6)
  })

  it('leaves out a shot that starts past the end of its file', () => {
    const { seq, warnings } = build(undefined, { durationS: 7 })
    const clips = videoTracks(seq)[0].clips
    expect(clips).toHaveLength(3)
    expect(warnings.some((w) => /left out/.test(w))).toBe(true)
  })

  it('says nothing for a plan that fits', () => {
    expect(build().warnings).toEqual([])
  })

  it('warns about a shot that rounds to no frames, and leaves it out', () => {
    // 1.00 s plus 10 ms is frame 30.3, and the next cut starts at 1.01 s, also frame 30.
    const { seq, warnings } = build((p) => {
      p.timeline = [
        { clip: 'c1', src_in: 0, src_out: 0.01, at: 1.0 },
        { clip: 'c2', src_in: 0, src_out: 2, at: 1.01 },
      ]
    })
    expect(videoTracks(seq)[0].clips).toHaveLength(1)
    expect(warnings).toEqual(['Shot 1 is shorter than one frame, so it was left out.'])
  })

  it('refuses a plan clip that has no media', () => {
    const plan = loadPlan()
    const project = newReelPlanProject(plan, 'x')
    const assets = assetsFor(plan)
    delete assets.c2
    expect(() => applyReelPlan(activeSequence(project), plan, assets)).toThrow(/c2/)
  })
})

describe('the titles', () => {
  it('makes one title clip per plan title, at the plan time and length', () => {
    const { seq } = build()
    const titles = titleClips(seq)
    expect(titles).toHaveLength(3)
    expect(titles.map((c) => c.startS)).toEqual([0, 2, 11.7])
    expect(titles.map((c) => +(clipEndS(c) - c.startS).toFixed(6))).toEqual([1.8, 2.5, 2.5])
    expect(titles.map((c) => c.title?.text.replace(/\n/g, ' ').toLowerCase())).toEqual([
      'stop doing bench like this',
      'three sets. no ego.',
      'try it this week',
    ])
  })

  it('keeps titles above the picture, off V1', () => {
    const { seq } = build()
    expect(videoTracks(seq)[0].clips.every((c) => c.title === undefined)).toBe(true)
    expect(titleTracks(seq).length).toBeGreaterThan(0)
  })

  it('puts two titles that are on screen together on two tracks', () => {
    const { seq } = build((p) => {
      p.titles[1].at = 1.0
    })
    const used = titleTracks(seq).filter((t) => t.clips.length > 0)
    expect(used.length).toBe(2)
    for (const t of used) {
      for (let i = 1; i < t.clips.length; i++) expect(t.clips[i].startS).toBeGreaterThanOrEqual(clipEndS(t.clips[i - 1]) - 1e-6)
    }
  })

  it('shares one track between titles that do not meet', () => {
    const { seq } = build()
    expect(titleTracks(seq).filter((t) => t.clips.length > 0)).toHaveLength(1)
  })

  it('centres each title in its box', () => {
    const { seq } = build()
    const [hook] = titleClips(seq)
    // box [90, 300, 860, 400]: centre (520, 500) in a 1080 by 1920 frame.
    expect(hook.title?.offsetXPx).toBe(520 - 540)
    expect(hook.title?.offsetYPx).toBe(500 - 960)
    expect(hook.title?.align).toBe('center')
    expect(hook.title?.vAlign).toBe('middle')
  })

  it('wears the look the style names: hook is the headline pop', () => {
    expect(reelTitleLook('hook').id).toBe('headline-pop')
    expect(reelTitleLook('HOOK').id).toBe('headline-pop')
    expect(reelTitleLook('punch').id).toBe('yellow-punch')
    expect(reelTitleLook('a style nobody wrote yet').id).toBe('caption-bar')
    const { seq } = build()
    const [hook, body] = titleClips(seq)
    expect(hook.title?.fontSizePx).toBeGreaterThanOrEqual(28)
    expect(body.title?.fontSizePx).toBeLessThanOrEqual(64)
  })

  it('breaks a long title into lines and shrinks it to stay inside its box', () => {
    const { seq } = build((p) => {
      p.titles[0].text = 'Stop doing bench press like this if you want healthy shoulders for years'
      p.titles[0].box = [60, 250, 600, 300]
    })
    const [t] = titleClips(seq)
    expect(t.title!.text).toContain('\n')
    expect(t.title!.fontSizePx).toBeLessThan(120)
    expect(t.title!.fontSizePx).toBeGreaterThanOrEqual(28)
  })

  it('leaves out a title that starts after the reel ends', () => {
    const { seq, warnings } = build((p) => {
      p.titles[2].at = 20
    })
    expect(titleClips(seq)).toHaveLength(2)
    expect(warnings.some((w) => /Title 3/.test(w))).toBe(true)
  })
})

describe('the captions', () => {
  it('lays one caption per plan word on a Captions track', () => {
    const { seq } = build()
    const track = named(seq, CAPTION_TRACK_NAME)
    expect(track).toBeDefined()
    expect(track!.clips).toHaveLength(3)
    expect(track!.clips.map((c) => c.title?.text.toLowerCase())).toEqual(['heavy', 'bench', 'day'])
    // 5.21 s and 5.51 s fall between frames at 30 fps and land on frames 156 and 165.
    expect(track!.clips.map((c) => Math.round(c.startS * 30))).toEqual([150, 156, 165])
  })

  it('sits above every title track', () => {
    const { seq } = build()
    const vts = videoTracks(seq)
    expect(vts[vts.length - 1].name).toBe(CAPTION_TRACK_NAME)
  })

  it('warns about a caption that starts after the end of the reel, and leaves it out', () => {
    const { seq, warnings } = build((p) => {
      p.captions[2].at = 20
    })
    expect(named(seq, CAPTION_TRACK_NAME)!.clips.map((c) => c.title?.text.toLowerCase())).toEqual(['heavy', 'bench'])
    expect(warnings).toEqual(['Caption “day” starts after the end of the reel, so it was left out.'])
  })

  it('keeps a caption that only runs past the end, cut at the end', () => {
    const { seq, warnings } = build((p) => {
      p.captions[2].at = 14.1
      p.captions[2].dur = 0.5
    })
    const last = named(seq, CAPTION_TRACK_NAME)!.clips.at(-1)!
    expect(clipEndS(last)).toBeCloseTo(14.2, 5)
    expect(warnings).toEqual([])
  })

  it('warns about a caption that falls on the same frame as the next one, and leaves it out', () => {
    // 5.00 s and 5.01 s are both frame 150 at 30 fps.
    const { seq, warnings } = build((p) => {
      p.captions = [
        { word: 'Heavy', at: 5.0, dur: 0.21 },
        { word: 'bench', at: 5.01, dur: 0.3 },
      ]
    })
    expect(named(seq, CAPTION_TRACK_NAME)!.clips.map((c) => c.title?.text.toLowerCase())).toEqual(['bench'])
    expect(warnings).toEqual(['Caption “Heavy” falls on the same frame as the next one, so it was left out.'])
  })

  it('makes no Captions track when the plan has no words', () => {
    const { seq } = build((p) => {
      p.captions = []
    })
    expect(named(seq, CAPTION_TRACK_NAME)).toBeUndefined()
  })
})
