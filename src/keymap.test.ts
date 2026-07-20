import { describe, expect, it } from 'vitest'
import {
  comboLabel,
  dedupeBindings,
  DOMAIN_ORDER,
  fuzzyScore,
  groupBindings,
  searchBindings,
  type Binding,
  type BindingDomain,
} from './keymap'

const noop = () => {}
const b = (combo: string, description: string, domain: BindingDomain): Binding => ({
  combo,
  description,
  domain,
  run: noop,
})

const SAMPLE: Binding[] = [
  b('space', 'Play / Pause', 'transport'),
  b('mod+z', 'Undo', 'project'),
  b('mod+shift+z', 'Redo', 'project'),
  b('mod+y', 'Redo', 'project'),
  b('s', 'Toggle snapping', 'tools'),
  b('c', 'Split at playhead', 'trim'),
  b('mod+a', 'Select all clips', 'selection'),
  b('=', 'Zoom in timeline', 'view'),
]

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyScore('tsn', 'Toggle snapping')).not.toBeNull()
    expect(fuzzyScore('SNAP', 'Toggle snapping')).not.toBeNull()
  })

  it('rejects non-subsequences', () => {
    expect(fuzzyScore('xyz', 'Toggle snapping')).toBeNull()
    expect(fuzzyScore('pans', 'snap')).toBeNull()
  })

  it('empty query matches everything with a zero score', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('ignores spaces in the query', () => {
    expect(fuzzyScore('toggle snapping', 'Toggle snapping')).not.toBeNull()
  })

  it('ranks contiguous word-start hits above scattered hits', () => {
    const tight = fuzzyScore('snap', 'Toggle snapping')
    const scattered = fuzzyScore('snap', 'Selection and play')
    expect(tight).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(tight!).toBeGreaterThan(scattered!)
  })
})

describe('dedupeBindings', () => {
  it('collapses aliases to the first combo per description', () => {
    const rows = dedupeBindings(SAMPLE)
    const redos = rows.filter((r) => r.description === 'Redo')
    expect(redos).toHaveLength(1)
    expect(redos[0].combo).toBe('mod+shift+z')
  })
})

describe('groupBindings', () => {
  it('groups deduped rows by domain in display order and drops empty domains', () => {
    const groups = groupBindings(SAMPLE)
    const domains = groups.map((g) => g.domain)
    expect(domains).toEqual(
      DOMAIN_ORDER.filter((d) => SAMPLE.some((x) => x.domain === d)),
    )
    const project = groups.find((g) => g.domain === 'project')!
    expect(project.rows.map((r) => r.description)).toEqual(['Undo', 'Redo'])
  })
})

describe('searchBindings', () => {
  it('returns every deduped command in keymap order for an empty query', () => {
    const rows = searchBindings(SAMPLE, '')
    expect(rows.map((r) => r.description)).toEqual([
      'Play / Pause',
      'Undo',
      'Redo',
      'Toggle snapping',
      'Split at playhead',
      'Select all clips',
      'Zoom in timeline',
    ])
  })

  it('filters to fuzzy matches and puts the tightest match first', () => {
    const rows = searchBindings(SAMPLE, 'snap')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].description).toBe('Toggle snapping')
    expect(rows.map((r) => r.description)).not.toContain('Undo')
  })

  it('matches on the shortcut label too', () => {
    // comboLabel('mod+a') is 'Ctrl+A' off-mac; 'ctrl+a' should surface it.
    const label = comboLabel('mod+a').toLowerCase()
    const rows = searchBindings(SAMPLE, label)
    expect(rows.map((r) => r.description)).toContain('Select all clips')
  })
})
