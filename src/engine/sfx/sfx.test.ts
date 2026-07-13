import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SFX_LIBRARY, sfxAssetName, sfxById } from './sfx'

const PUBLIC_SFX = join(__dirname, '..', '..', '..', 'public', 'sfx')

describe('bundled SFX pack', () => {
  it('has entries with unique ids and sane durations', () => {
    expect(SFX_LIBRARY.length).toBeGreaterThanOrEqual(8)
    expect(new Set(SFX_LIBRARY.map((s) => s.id)).size).toBe(SFX_LIBRARY.length)
    for (const s of SFX_LIBRARY) {
      expect(s.durationS).toBeGreaterThan(0)
      expect(s.durationS).toBeLessThan(5) // stingers, not tracks
      expect(s.name.trim().length).toBeGreaterThan(0)
    }
  })

  it('every manifest entry has its WAV committed in public/sfx', () => {
    for (const s of SFX_LIBRARY) {
      const path = join(PUBLIC_SFX, s.file)
      expect(existsSync(path), `${s.file} missing — run node scripts/gen-sfx.mjs`).toBe(true)
      expect(statSync(path).size).toBeGreaterThan(1000)
      // 16-bit mono 48kHz WAV whose data length matches the manifest duration
      const head = readFileSync(path).subarray(0, 44)
      expect(head.toString('ascii', 0, 4)).toBe('RIFF')
      expect(head.readUInt32LE(24)).toBe(48000)
      const frames = head.readUInt32LE(40) / 2
      expect(frames / 48000).toBeCloseTo(s.durationS, 2)
    }
  })

  it('the pack stays lightweight (bundled into every deploy)', () => {
    const total = SFX_LIBRARY.reduce((sum, s) => sum + statSync(join(PUBLIC_SFX, s.file)).size, 0)
    expect(total).toBeLessThan(1_500_000)
  })

  it('lookup and asset naming behave', () => {
    expect(sfxById('boom')?.name).toBe('Deep Boom')
    expect(sfxById('nope')).toBeUndefined()
    expect(sfxAssetName(SFX_LIBRARY[0])).toContain('SFX · ')
  })
})
