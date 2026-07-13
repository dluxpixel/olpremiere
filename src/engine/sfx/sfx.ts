// The bundled SFX pack: original, procedurally-synthesized stingers generated
// by scripts/gen-sfx.mjs into public/sfx/ (no third-party samples, no license
// tail). The manifest is generated alongside the WAVs so names, files, and
// durations can never drift from the audio on disk.

import manifest from './manifest.json'

export interface SfxDef {
  id: string
  name: string
  file: string
  durationS: number
}

export const SFX_LIBRARY: readonly SfxDef[] = manifest

export const sfxById = (id: string): SfxDef | undefined => SFX_LIBRARY.find((s) => s.id === id)

/** The project-asset name an inserted SFX gets (also the dedupe key). */
export const sfxAssetName = (def: SfxDef): string => `SFX · ${def.name}`

export const sfxUrl = (def: SfxDef): string => `${import.meta.env.BASE_URL}sfx/${def.file}`
