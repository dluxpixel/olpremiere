import { describe, expect, it } from 'vitest'

import type { MediaAsset, Project } from '../engine/types'
import { base64ToBytes, blobKeysOf, bytesToBase64, projectFileName } from './projectFile'

describe('base64 round-trip', () => {
  it('encodes and decodes bytes losslessly', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42])
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
  })

  it('handles a large buffer (chunked, no arg-limit overflow)', () => {
    const bytes = new Uint8Array(100_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const round = base64ToBytes(bytesToBase64(bytes))
    expect(round.length).toBe(bytes.length)
    expect(round[0]).toBe(0)
    expect(round[99_999]).toBe(99_999 % 256)
  })
})

describe('blobKeysOf', () => {
  const asset = (over: Partial<MediaAsset>): MediaAsset => ({
    id: 'a',
    name: 'a',
    kind: 'video',
    blobKey: 'asset/a',
    durationS: 1,
    hasAudio: true,
    hasVideo: true,
    ...over,
  })

  it('collects media + thumbnail keys, de-duped', () => {
    const project = {
      assets: {
        a: asset({ id: 'a', blobKey: 'asset/a', thumbnailKey: 'thumb/a' }),
        b: asset({ id: 'b', blobKey: 'asset/b' }),
      },
    } as unknown as Project
    expect(blobKeysOf(project).sort()).toEqual(['asset/a', 'asset/b', 'thumb/a'])
  })
})

describe('projectFileName', () => {
  it('sanitizes the name and appends the extension', () => {
    expect(projectFileName('My Short #1!')).toBe('My Short 1.olstudio.json')
  })
  it('falls back when the name is empty after sanitizing', () => {
    expect(projectFileName('***')).toBe('project.olstudio.json')
  })
})
