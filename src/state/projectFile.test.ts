import { describe, expect, it } from 'vitest'

import { newProject, type MediaAsset, type Project } from '../engine/types'
import {
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_VERSION,
  base64ToBytes,
  blobKeysOf,
  bytesToBase64,
  copyName,
  decodeHeader,
  encodeHeader,
  incompleteFileMessage,
  isBinaryProjectFile,
  looksLikeJson,
  planBlobRanges,
  planProjectCopy,
  projectFileName,
} from './projectFile'

describe('v2 binary header', () => {
  const header = () => ({
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    project: newProject('Head Test'),
    blobs: [
      { key: 'asset/a', type: 'video/mp4', size: 1234 },
      { key: 'thumb/a', type: 'image/jpeg', size: 56 },
    ],
  })

  it('encodes and decodes losslessly, reporting the body offset', () => {
    // ONE header instance: newProject() mints fresh ids/timestamps per call.
    const h = header()
    const bytes = encodeHeader(h)
    expect(isBinaryProjectFile(bytes)).toBe(true)
    const decoded = decodeHeader(bytes)
    expect(decoded).not.toBeNull()
    expect(decoded!.header).toEqual(h)
    expect(decoded!.bodyOffset).toBe(bytes.length)
  })

  it('rejects garbage and truncated prefixes', () => {
    expect(isBinaryProjectFile(new TextEncoder().encode('NOTMAGIC'))).toBe(false)
    expect(decodeHeader(new Uint8Array(4))).toBeNull()
    const bytes = encodeHeader(header())
    expect(decodeHeader(bytes.subarray(0, 20))).toBeNull() // header cut short
  })

  it('rejects a wrong-format header', () => {
    const bytes = encodeHeader({ ...header(), format: 'other' })
    expect(decodeHeader(bytes)).toBeNull()
  })
})

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

describe('planBlobRanges', () => {
  const blobs = [
    { key: 'asset/a', type: 'video/mp4', size: 100 },
    { key: 'asset/b', type: 'video/mp4', size: 50 },
  ]

  it('maps each blob onto its byte range when the file is whole', () => {
    const plan = planBlobRanges(blobs, 20, 170)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ranges).toEqual([
      { key: 'asset/a', type: 'video/mp4', start: 20, end: 120 },
      { key: 'asset/b', type: 'video/mp4', start: 120, end: 170 },
    ])
  })

  // The one that mattered: Blob.slice clamps instead of failing, so a truncated
  // copy used to import as a project whose media were all empty and still say
  // "Opened".
  it('refuses a truncated file and counts what is missing', () => {
    const plan = planBlobRanges(blobs, 20, 130)
    expect(plan).toEqual({ ok: false, missing: 1, total: 2 })
  })

  it('refuses when the body is missing entirely', () => {
    expect(planBlobRanges(blobs, 20, 20)).toEqual({ ok: false, missing: 2, total: 2 })
  })

  it('tolerates trailing bytes after the last blob', () => {
    expect(planBlobRanges(blobs, 20, 500).ok).toBe(true)
  })

  it('accepts a project with no media at all', () => {
    expect(planBlobRanges([], 20, 20)).toEqual({ ok: true, ranges: [] })
  })

  it('defaults a blank mime type rather than writing an empty one', () => {
    const plan = planBlobRanges([{ key: 'k', type: '', size: 1 }], 0, 1)
    expect(plan.ok && plan.ranges[0].type).toBe('application/octet-stream')
  })

  // A size that is not a real byte count used to sail straight through: NaN
  // comparisons are always false, and a negative size walks the offset backwards.
  // Both ended in empty media imported as a success.
  it('treats a nonsense size as missing rather than trusting it', () => {
    const bad = (size: unknown) => planBlobRanges([{ key: 'k', type: 'video/mp4', size } as never], 0, 1000)
    expect(bad(Number.NaN)).toEqual({ ok: false, missing: 1, total: 1 })
    expect(bad(-50)).toEqual({ ok: false, missing: 1, total: 1 })
    expect(bad(undefined)).toEqual({ ok: false, missing: 1, total: 1 })
    expect(bad(1.5)).toEqual({ ok: false, missing: 1, total: 1 })
    expect(bad(Number.MAX_SAFE_INTEGER + 2)).toEqual({ ok: false, missing: 1, total: 1 })
  })

  it('still accepts a genuinely empty blob', () => {
    expect(planBlobRanges([{ key: 'k', type: 'video/mp4', size: 0 }], 0, 0)).toEqual({
      ok: true,
      ranges: [{ key: 'k', type: 'video/mp4', start: 0, end: 0 }],
    })
  })

  it('says how many are missing, in words he can act on', () => {
    expect(incompleteFileMessage(4, 12)).toBe(
      'That project file is incomplete: 4 of 12 media items are missing. Copy it again.',
    )
  })
})

describe('planProjectCopy', () => {
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

  const incoming = (): Project =>
    ({
      ...newProject('Gameplay cut'),
      assets: {
        a: asset({ id: 'a', blobKey: 'asset/a', thumbnailKey: 'thumb/a' }),
        b: asset({ id: 'b', blobKey: 'asset/a' }), // deliberately shares a's bytes
      },
    }) as Project

  it('gives the copy its own id, name and media keys', () => {
    const src = incoming()
    const { project, keyMap } = planProjectCopy(src, 'new-id', '123456')
    expect(project.id).toBe('new-id')
    expect(project.name).toBe('Gameplay cut (copy)')
    expect(project.assets.a.blobKey).toBe('asset/a-123456')
    expect(project.assets.a.thumbnailKey).toBe('thumb/a-123456')
    // A shared key maps once, so both assets still point at the same bytes.
    expect(project.assets.b.blobKey).toBe('asset/a-123456')
    expect(keyMap).toEqual({ 'asset/a': 'asset/a-123456', 'thumb/a': 'thumb/a-123456' })
  })

  it('leaves the incoming project object untouched', () => {
    const src = incoming()
    planProjectCopy(src, 'new-id', '123456')
    expect(src.assets.a.blobKey).toBe('asset/a')
    expect(src.name).toBe('Gameplay cut')
  })

  it('does not stack "(copy)" when the same file is opened twice', () => {
    expect(copyName('Gameplay cut')).toBe('Gameplay cut (copy)')
    expect(copyName('Gameplay cut (copy)')).toBe('Gameplay cut (copy)')
    expect(copyName('  spaced  ')).toBe('spaced (copy)')
  })
})

describe('looksLikeJson', () => {
  const head = (s: string) => new TextEncoder().encode(s)

  // A real v1 backup inlines its media as base64, so it is legitimately tens of
  // megabytes. Deciding on the opening bytes instead of on size is what keeps
  // those files openable.
  it('accepts a v1 document, with or without leading whitespace and a BOM', () => {
    expect(looksLikeJson(head('{"format":"olstudio-project"'))).toBe(true)
    expect(looksLikeJson(head('\r\n  {"format"'))).toBe(true)
    expect(looksLikeJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b]))).toBe(true)
  })

  it('rejects binary that merely lost its magic bytes, before any whole-file read', () => {
    expect(looksLikeJson(new Uint8Array([0, 1, 2, 3]))).toBe(false)
    expect(looksLikeJson(head('OLSTPROJ'))).toBe(false)
    expect(looksLikeJson(head('not json at all'))).toBe(false)
    expect(looksLikeJson(new Uint8Array(0))).toBe(false)
  })
})

describe('projectFileName', () => {
  it('sanitizes the name and appends the extension', () => {
    expect(projectFileName('My Short #1!')).toBe('My Short 1.olstudio')
  })
  it('falls back when the name is empty after sanitizing', () => {
    expect(projectFileName('***')).toBe('project.olstudio')
  })
})
