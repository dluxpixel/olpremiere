// The rule that turns silence into a sentence.
//
// ⛔ THE NEGATIVE CASES ARE THE ONES THAT MATTER. A warning that fires on a
// project with no audio in it, or on a solo that is working exactly as asked, is
// worse than no warning: he stops reading them, and then the one that would have
// saved him an hour goes past unread too.

import { describe, expect, it } from 'vitest'
import { diagnoseSilence, FLOOR_DB } from './audioSilence'
import type { Clip, Track } from './types'

const clip = (over: Partial<Clip> = {}): Clip =>
  ({ id: `c${Math.abs(Math.round(over.startS ?? 0))}`, enabled: true, startS: 0, ...over }) as Clip

const track = (over: Partial<Track> = {}): Track =>
  ({
    id: over.name ?? 't',
    kind: 'audio',
    name: 'A1',
    height: 60,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [],
    ...over,
  }) as Track

describe('diagnoseSilence', () => {
  it('says nothing when the mix can make a sound', () => {
    expect(diagnoseSilence([track({ clips: [clip()] })])).toBeNull()
  })

  it('says nothing about a project with no audio in it, which is not a fault', () => {
    // A video track whose only clip is LINKED emits nothing of its own, so this
    // is a timeline with no sound anywhere. Silent, correctly, and not worth a word.
    expect(
      diagnoseSilence([track({ kind: 'video', name: 'V1', clips: [clip({ linkId: 'L' } as Partial<Clip>)] })]),
    ).toBeNull()
  })

  it('says nothing when a solo is doing exactly what it was asked to', () => {
    const found = diagnoseSilence([
      track({ name: 'A1', solo: true, clips: [clip()] }),
      track({ name: 'A2', clips: [clip()] }),
    ])
    expect(found).toBeNull()
  })

  it('names the soloed track when the solo has no sound on it', () => {
    const found = diagnoseSilence([
      track({ name: 'A1', solo: true }),
      track({ name: 'A2', clips: [clip()] }),
    ])
    expect(found?.fix).toBe('unsolo')
    expect(found?.message).toContain('A1')
  })

  it('explains the linked-video solo, which schedules literally nothing', () => {
    // Soloing V1 on a linked A/V edit is the worst version: the video clip's
    // sound lives on A1, and A1 is not soloed, so the mixer builds an empty graph.
    const found = diagnoseSilence([
      track({ kind: 'video', name: 'V1', solo: true, clips: [clip({ linkId: 'L' } as Partial<Clip>)] }),
      track({ name: 'A1', clips: [clip({ linkId: 'L' } as Partial<Clip>)] }),
    ])
    expect(found?.fix).toBe('unsolo')
    expect(found?.message).toContain('V1')
    expect(found?.message).toContain('linked')
  })

  it('reports every sound track being muted, and offers the way out', () => {
    const found = diagnoseSilence([
      track({ name: 'A1', muted: true, clips: [clip()] }),
      track({ name: 'A2', muted: true, clips: [clip()] }),
    ])
    expect(found?.fix).toBe('unmute')
    expect(found?.message).toContain('muted')
  })

  it('reports faders parked on the floor, which look nothing like a mute', () => {
    const found = diagnoseSilence([track({ name: 'A1', volumeDb: FLOOR_DB, clips: [clip()] })])
    expect(found?.key).toBe('floor')
    expect(found?.fix).toBeUndefined() // nothing sensible to restore them TO
    expect(found?.message).toContain('A1')
  })

  it('stays quiet when one track is still up, however many are down', () => {
    expect(
      diagnoseSilence([
        track({ name: 'A1', volumeDb: FLOOR_DB, clips: [clip()] }),
        track({ name: 'A2', volumeDb: -6, clips: [clip()] }),
      ]),
    ).toBeNull()
  })

  it('ignores a clip that is switched off', () => {
    const found = diagnoseSilence([
      track({ name: 'A1', solo: true, clips: [clip({ enabled: false })] }),
      track({ name: 'A2', clips: [clip()] }),
    ])
    // A1's only clip is disabled, so soloing it really does mean silence.
    expect(found?.fix).toBe('unsolo')
  })
})
