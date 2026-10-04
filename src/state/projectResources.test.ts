// An edit tab going to sleep lets go of what it held. Before tabs, opening another
// project left the last one's decoders, frames, decoded sound and preview elements
// in memory until the caches happened to push them out; with three edits open
// that was three edits' worth, paid for by the one on screen.
//
// Every engine cache is mocked down to a log of what was released, so these read
// as the contract: heavy goes the moment he leaves, thumbnails one switch later,
// and media the edit on screen uses is never touched.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type MediaAsset, type Project } from '../engine/types'

const log: string[] = []
const said = (what: string) => (id: string) => log.push(`${what}:${id}`)

vi.mock('../engine/frameCache', () => ({ evictAsset: said('frames') }))
vi.mock('../engine/preview', () => ({
  disposePreviewAsset: said('elements'),
  releasePreviewScratch: () => log.push('preview-scratch'),
}))
vi.mock('../engine/audio', () => ({
  forgetAssetAudio: said('sound'),
  cancelAudioWarm: () => log.push('audio-warm-stopped'),
}))
vi.mock('../engine/denoise', () => ({ invalidateDenoise: said('denoise') }))
vi.mock('../engine/proxyMedia', () => ({ forgetProxy: said('proxy') }))
vi.mock('../engine/render/titleRaster', () => ({ clearTitleCache: () => log.push('titles') }))
vi.mock('../engine/waveform', () => ({ forgetAssetPeaks: said('peaks') }))
vi.mock('./filmstrips', () => ({ releaseStripVideo: said('strip-video'), forgetAssetStrips: said('strips') }))
vi.mock('./blobUrls', () => ({ revokeBlobUrl: said('url') }))

const { drainReleases, releaseClosedEdit, releaseSleepingEdit: queueRelease, resetWarmEditForTests } = await import('./projectResources')
const { useStore } = await import('./store')

/** A switch from prev to next, with its queued half run, as it is once the new edit is up. */
function releaseSleepingEdit(prev: Project, next: Project) {
  useStore.getState().setProject(next)
  const r = queueRelease(prev, next)
  drainReleases()
  return r
}

const asset = (id: string, blobKey = `asset/${id}`): MediaAsset => ({
  id,
  name: id,
  kind: 'video',
  blobKey,
  thumbnailKey: `thumb/${id}`,
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
})
const edit = (name: string, ...media: MediaAsset[]): Project => ({
  ...newProject(name),
  assets: Object.fromEntries(media.map((a) => [a.id, a])),
})
/** What was released for one asset, in the order it happened. */
const forAsset = (id: string): string[] => log.filter((l) => l.endsWith(`:${id}`)).map((l) => l.split(':')[0])
/** Everything an asset of the edit he left lets go of: its waiting preview copy at once, the rest queued. */
const HEAVY = ['proxy', 'frames', 'elements', 'sound', 'denoise', 'strip-video']
const CHEAP = ['peaks', 'strips']

beforeEach(() => {
  log.length = 0
  resetWarmEditForTests()
})

describe('the edit he leaves', () => {
  it('lets go of every decoder, frame, element and sound it held, at once', () => {
    const green = edit('Green', asset('g1'), asset('g2'))
    const mc = edit('mc night', asset('m1'))
    const r = releaseSleepingEdit(green, mc)
    expect(r.heavy.sort()).toEqual(['g1', 'g2'])
    expect(forAsset('g1')).toEqual(HEAVY)
    expect(forAsset('g2')).toEqual(HEAVY)
    // Nothing of the edit he landed on.
    expect(forAsset('m1')).toEqual([])
    // Nothing new decodes ahead for it, and the per-edit preview state goes.
    expect(log).toContain('audio-warm-stopped')
    expect(log).toContain('titles')
    expect(log).toContain('preview-scratch')
  })

  it('keeps its thumbnails and waveforms for one switch, so clicking straight back is quick', () => {
    const green = edit('Green', asset('g1'))
    const mc = edit('mc night', asset('m1'))
    releaseSleepingEdit(green, mc)
    expect(forAsset('g1').filter((w) => CHEAP.includes(w) || w === 'url')).toEqual([])
    // Straight back: Green is on screen, mc night is the warm one now.
    log.length = 0
    releaseSleepingEdit(mc, green)
    expect(forAsset('g1')).toEqual([])
    expect(forAsset('m1')).toEqual(HEAVY)
  })

  it('lets the thumbnails go one switch later, when a third edit comes on screen', () => {
    const green = edit('Green', asset('g1'))
    const mc = edit('mc night', asset('m1'))
    const bc = edit('BC', asset('b1'))
    releaseSleepingEdit(green, mc)
    log.length = 0
    const r = releaseSleepingEdit(mc, bc)
    expect(r.cheap).toEqual(['g1'])
    expect(forAsset('g1')).toEqual(CHEAP)
    expect(log).toContain('url:asset/g1')
    expect(log).toContain('url:thumb/g1')
    // mc night is the warm one now: heavy gone, thumbnails kept.
    expect(forAsset('m1')).toEqual(HEAVY)
  })
})

describe('the heavy half runs after the switch, not in it', () => {
  it('stops decoding ahead and drops waiting preview copies at once, and queues the rest', () => {
    const green = edit('Green', asset('g1'))
    const mc = edit('mc night', asset('m1'))
    useStore.getState().setProject(mc)
    queueRelease(green, mc)
    // Measured: unloading a full pool of video elements is about 100 ms of
    // synchronous work, and in the switch it kept the woken edit off the screen.
    expect(log).toEqual(['audio-warm-stopped', 'titles', 'proxy:g1'])
    drainReleases()
    expect(forAsset('g1')).toEqual(HEAVY)
  })

  it('a quick click straight back finds its media still warm, not torn down under it', () => {
    const green = edit('Green', asset('g1'))
    const mc = edit('mc night', asset('m1'))
    useStore.getState().setProject(mc)
    queueRelease(green, mc)
    // Back on Green before the queue had its idle moment.
    useStore.getState().setProject(green)
    queueRelease(mc, green)
    drainReleases()
    expect(forAsset('g1')).toEqual(['proxy'])
    expect(forAsset('m1')).toEqual(HEAVY)
  })
})

describe('media both edits use is never released', () => {
  it('a clip pasted across brings its media, and that media stays warm on both sides', () => {
    const shared = asset('gym-footage')
    const green = edit('Green', shared, asset('g1'))
    const mc = edit('mc night', shared)
    releaseSleepingEdit(green, mc)
    expect(forAsset('gym-footage')).toEqual([])
    expect(forAsset('g1')).toEqual(HEAVY)
  })

  it('the same id over DIFFERENT bytes is not the same media, and is released', () => {
    const green = edit('Green', asset('a1', 'asset/a1'))
    const copy = edit('Green copy', asset('a1', 'asset/a1-copy'))
    releaseSleepingEdit(green, copy)
    expect(forAsset('a1')).toEqual(HEAVY)
  })

  it('a URL the edit on screen reads through is never revoked, even for an asset it does not share', () => {
    const green = edit('Green', asset('g1', 'asset/shared-bytes'))
    const mc = edit('mc night', asset('m1'))
    const bc = edit('BC', asset('b1', 'asset/shared-bytes'))
    releaseSleepingEdit(green, mc)
    log.length = 0
    releaseSleepingEdit(mc, bc)
    expect(log).not.toContain('url:asset/shared-bytes')
    expect(log).toContain('url:thumb/g1')
  })
})

describe('a closed tab', () => {
  it('keeps nothing, even as the warm one', () => {
    const green = edit('Green', asset('g1'))
    const mc = edit('mc night', asset('m1'))
    releaseSleepingEdit(green, mc)
    log.length = 0
    expect(releaseClosedEdit(green, mc)).toEqual(['g1'])
    expect(forAsset('g1')).toEqual(CHEAP)
    expect(log).toEqual(expect.arrayContaining(['url:asset/g1', 'url:thumb/g1']))
    // And only once.
    log.length = 0
    expect(releaseClosedEdit(green, mc)).toEqual([])
  })
})
