/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, for the page's clipboard.
 */

// Copy in one edit tab, click another, paste. His words, 2026-10-03: *"make it so
// I can copy things from edit to edit like if im editing something different:
// make it so I can do cross-edits"*.
//
// The tab he copied from goes to SLEEP in between (editTabs.ts): saved, its media
// let go, its document out of the store. So these copy in one tab, really switch,
// and paste in the other, and check that what lands is whole: the media record,
// titles, effects, captions and keyframes, linked pairs still linked to each
// other and to nothing else, and a multi-track selection still stacked the way it
// was.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addEffect } from '../engine/effects/ops'
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Project,
} from '../engine/types'
import { recomputeDuration } from '../engine/timeline'
import { copySelection, pasteAtPlayhead } from './clipboard'
import { resetEditTabsForTests, switchTo } from './editTabs'
import { updateActiveSequence, useStore } from './store'

const saved = new Map<string, Project>()
const toasts: string[] = []

vi.mock('./persistence', () => ({
  saveSettled: vi.fn(async () => {
    const p = useStore.getState().project
    saved.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => {
    const p = saved.get(id)
    return p ? (JSON.parse(JSON.stringify(p)) as Project) : null
  }),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  listProjects: vi.fn(async () => []),
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./projectResources', () => ({
  releaseSleepingEdit: () => ({ heavy: [], cheap: [] }),
  releaseClosedEdit: () => [],
}))
vi.mock('./transcribeActions', () => ({ useTranscribe: { getState: () => ({ status: 'idle' }) } }))
vi.mock('./voiceRecorder', () => ({ useRecorder: { getState: () => ({ recording: false, pendingTake: null, keeping: false }) } }))
vi.mock('./mediaActions', () => ({ useImportProgress: { getState: () => ({ total: 0 }) } }))

const footage: MediaAsset = {
  id: 'green-footage',
  name: 'round 2.mp4',
  kind: 'video',
  blobKey: 'asset/green-footage',
  durationS: 30,
  hasAudio: true,
  hasVideo: true,
  words: [{ text: 'national', startS: 1, endS: 1.4 }],
}

const seq = () => activeSequence(useStore.getState().project)
const allClips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)
const trackOf = (id: string): string => seq().tracks.find((t) => t.clips.some((c) => c.id === id))!.name

/** Put clips on tracks by index. newProject() is [V1, V2, A1, A2]. */
function lay(byTrack: Record<number, Clip[]>): void {
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (byTrack[i] ? { ...t, clips: byTrack[i] } : t)) }),
  )
}

/**
 * GYM-shaped: a linked video and audio pair of his footage with a look on it and
 * a punch keyframed in, a title over it, and a caption the speech model wrote.
 */
function greenEdit(): { green: Project; mc: Project } {
  const green = { ...newProject('Green'), assets: { [footage.id]: footage } }
  const mc = newProject('mc night')
  saved.set(green.id, green)
  saved.set(mc.id, mc)
  useStore.getState().setProject(green)
  const video: Clip = {
    ...addEffect({ ...newClipFromAsset(footage, 2), id: 'v' }, 'autoColor', 'look'),
    linkId: 'pair',
    keyframes: { scale: [{ t: 0, value: 1, ease: 'linear' }, { t: 0.2, value: 1.2, ease: 'easeOut' }] },
  }
  const audio: Clip = { ...newClipFromAsset(footage, 2), id: 'a', linkId: 'pair' }
  const title: Clip = { ...newTitleClip(defaultTitleDef('ROUND 2'), 2.5, 1), id: 't' }
  const caption: Clip = {
    ...newTitleClip(defaultTitleDef('national champion'), 4, 1),
    id: 'cap',
    captionOrigin: { text: 'national champion', model: 'whisper-base' },
  }
  lay({ 0: [video], 1: [title, caption], 2: [audio] })
  return { green, mc }
}

beforeEach(() => {
  saved.clear()
  toasts.length = 0
  resetEditTabsForTests()
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })
})

describe('copy in one tab, paste in another', () => {
  it('lands whole: media, titles, effects, captions and keyframes, after the tab it came from went to sleep', async () => {
    const { green, mc } = greenEdit()
    const before = allClips()
    useStore.getState().setUI({ selection: ['v', 'a', 't', 'cap'] })
    expect(copySelection()).toBe(true)

    expect(await switchTo(mc.id)).toBe('ok')
    // Green is asleep: not in the store, written to disk, its media let go.
    expect(useStore.getState().project.id).toBe(mc.id)
    expect(saved.get(green.id)?.assets[footage.id]).toBeDefined()

    useStore.getState().setUI({ playheadS: 10 })
    pasteAtPlayhead()

    const pasted = allClips()
    expect(pasted).toHaveLength(4)
    // The media record came with the clips: same id, same bytes, his transcript.
    expect(useStore.getState().project.assets[footage.id]).toEqual(footage)
    const byOrigin = (id: string) => {
      const src = before.find((c) => c.id === id)!
      return pasted.find((c) => c.startS === 10 + (src.startS - 2))!
    }
    const v = byOrigin('v')
    expect(v.effects.map((e) => [e.type, e.params])).toEqual([['autoColor', before.find((c) => c.id === 'v')!.effects[0].params]])
    expect(v.keyframes).toEqual(before.find((c) => c.id === 'v')!.keyframes)
    const t = pasted.find((c) => c.title?.text === 'ROUND 2')!
    expect(t.startS).toBe(10.5)
    const cap = pasted.find((c) => c.captionOrigin)!
    expect(cap.title?.text).toBe('national champion')
    expect(cap.captionOrigin).toEqual({ text: 'national champion', model: 'whisper-base' })
    expect(cap.startS).toBe(12)
    // Each on the line it was copied from.
    expect([trackOf(v.id), trackOf(t.id), trackOf(cap.id)]).toEqual(['V1', 'V2', 'V2'])
    expect(toasts).not.toContain('1 clip needs media that is not on this computer, so it was left out')
  })

  it('a linked pair stays linked to each other, and to nothing back in the tab it came from', async () => {
    const { mc } = greenEdit()
    useStore.getState().setUI({ selection: ['v', 'a'] })
    copySelection()
    await switchTo(mc.id)
    pasteAtPlayhead()

    const [v, a] = [allClips().find((c) => trackOf(c.id) === 'V1')!, allClips().find((c) => trackOf(c.id) === 'A1')!]
    expect(v.linkId).toBeDefined()
    expect(v.linkId).toBe(a.linkId)
    expect(v.linkId).not.toBe('pair')
    expect(v.startS).toBe(a.startS)
  })

  it('a stacked selection keeps its stacking in a tab with fewer lines, growing the lines it needs', async () => {
    const { mc } = greenEdit()
    // mc night has ONE video line, and something on it where the paste lands.
    const busy = { ...newTitleClip(defaultTitleDef('busy'), 0, 20), id: 'busy' }
    saved.set(mc.id, {
      ...mc,
      sequences: {
        [mc.activeSequenceId]: recomputeDuration({
          ...activeSequence(mc),
          tracks: activeSequence(mc).tracks.filter((t) => t.name !== 'V2').map((t) => (t.name === 'V1' ? { ...t, clips: [busy] } : t)),
        }),
      },
    })
    // The footage on V1 under the title on V2, overlapping in time.
    useStore.getState().setUI({ selection: ['v', 't'] })
    copySelection()
    await switchTo(mc.id)
    useStore.getState().setUI({ playheadS: 0 })
    pasteAtPlayhead()

    const video = seq().tracks.filter((t) => t.kind === 'video')
    const lineOf = (pred: (c: Clip) => boolean) => video.findIndex((t) => t.clips.some(pred))
    const footageLine = lineOf((c) => c.assetId === footage.id)
    const titleLine = lineOf((c) => c.title?.text === 'ROUND 2')
    // Nothing landed on top of what was there, and the title is still above the footage.
    expect(video[0].clips.map((c) => c.id)).toEqual(['busy'])
    expect(footageLine).toBeGreaterThan(0)
    expect(titleLine).toBeGreaterThan(footageLine)
  })

  it('undoing the paste in the tab it landed in takes the clips and the media record back out', async () => {
    const { mc } = greenEdit()
    useStore.getState().setUI({ selection: ['v', 'a', 't', 'cap'] })
    copySelection()
    await switchTo(mc.id)
    pasteAtPlayhead()
    expect(useStore.getState().undo()).toBe('Paste clip(s)')
    expect(allClips()).toHaveLength(0)
    expect(useStore.getState().project.assets[footage.id]).toBeUndefined()
  })

  it('the tab it came from wakes untouched, with its own undo, and the copy still pastes there too', async () => {
    const { green, mc } = greenEdit()
    useStore.getState().setUI({ selection: ['t'] })
    copySelection()
    await switchTo(mc.id)
    pasteAtPlayhead()
    await switchTo(green.id)

    expect(allClips()).toHaveLength(4)
    expect(useStore.getState().history.undo.map((c) => c.label)).toEqual(['seed'])
    useStore.getState().setUI({ playheadS: 20 })
    pasteAtPlayhead()
    expect(allClips()).toHaveLength(5)
  })
})
