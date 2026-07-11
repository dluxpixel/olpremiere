import { describe, expect, it } from 'vitest'

import { newProject } from '../engine/types'
import { parseStoredProject } from './schema'

// Black-box: the canonical valid document is whatever newProject() produces, so
// the schema is pinned to the REAL Project shape rather than a hand-built mock.

describe('parseStoredProject', () => {
  it('accepts a real fresh project and returns it (ids preserved)', () => {
    const p = newProject('My Film')
    const parsed = parseStoredProject(p)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(p.id)
    expect(parsed!.name).toBe('My Film')
    expect(parsed!.activeSequenceId).toBe(p.activeSequenceId)
  })

  it('rejects non-objects rather than throwing', () => {
    for (const bad of [null, undefined, 42, 'nope', true, []]) {
      expect(parseStoredProject(bad)).toBeNull()
    }
  })

  it('rejects a document missing its sequences', () => {
    const doc = newProject() as unknown as Record<string, unknown>
    delete doc.sequences
    expect(parseStoredProject(doc)).toBeNull()
  })

  it('rejects a document whose assets is not a record', () => {
    expect(parseStoredProject({ ...newProject(), assets: 'not-a-record' })).toBeNull()
  })

  it('rejects a document missing a load-bearing scalar (activeSequenceId)', () => {
    const doc = newProject() as unknown as Record<string, unknown>
    delete doc.activeSequenceId
    expect(parseStoredProject(doc)).toBeNull()
  })

  it('is forward-compatible: unknown extra top-level keys pass and are preserved', () => {
    const withFuture = { ...newProject(), someFutureField: { nested: true } } as Record<string, unknown>
    const parsed = parseStoredProject(withFuture)
    expect(parsed).not.toBeNull()
    expect((parsed as unknown as Record<string, unknown>).someFutureField).toEqual({ nested: true })
  })

  it('never throws on deeply malformed input', () => {
    expect(() => parseStoredProject({ sequences: { a: { tracks: 'bad' } } })).not.toThrow()
    expect(parseStoredProject({ sequences: { a: { tracks: 'bad' } } })).toBeNull()
  })
})
