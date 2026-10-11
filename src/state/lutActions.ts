// Loading a .cube file into a LUT effect.
//
// The file is read and parsed BEFORE the project is touched, so a broken file
// changes nothing and costs no undo step. A good one is ONE dispatch: the table
// goes into `Project.luts` (where it travels with the project) and the effect is
// pointed at it, so Ctrl+Z takes both back together.

import { CubeError, parseCube, type ParsedCube } from '../engine/effects/cube'
import { lutAssetFromCube, registerCube } from '../engine/effects/lutBank'
import { activeSequence, type Id } from '../engine/types'
import { useStore } from './store'
import { useToasts } from './toasts'

/** A real LUT is a few MB at most (a 65 step cube is about 7 MB of text). Past this it is not one. */
export const MAX_LUT_FILE_BYTES = 40 * 1024 * 1024

export type LutLoadResult = { ok: true; name: string } | { ok: false; message: string }

/** What to tell him about a file that could not be read as a LUT, in plain words. */
export function lutErrorMessage(err: unknown): string {
  if (err instanceof CubeError) return err.message
  return 'That file could not be read as a LUT. Choose a .cube file.'
}

/**
 * Point a LUT effect on a clip at an already parsed table. One undo step. Returns
 * the words to show when it could not (a clip that is gone, a locked track).
 */
export function applyCubeToEffect(clipId: Id, effectId: Id, name: string, cube: ParsedCube): LutLoadResult {
  const seq = activeSequence(useStore.getState().project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  const effect = clip?.effects.find((e) => e.id === effectId)
  if (!track || !clip || !effect || effect.type !== 'lut') {
    return { ok: false, message: 'That effect is not on the clip any more.' }
  }
  if (track.locked) return { ok: false, message: 'Track is locked' }

  const asset = lutAssetFromCube(name, cube)
  // The renderer reads it from the bank the moment the project changes below.
  registerCube(asset.id, cube)
  useStore.getState().dispatch('Load LUT', (p) => {
    const s = p.sequences[p.activeSequenceId]
    const tracks = s.tracks.map((t) =>
      t.id !== track.id
        ? t
        : {
            ...t,
            clips: t.clips.map((c) =>
              c.id !== clipId
                ? c
                : { ...c, effects: c.effects.map((e) => (e.id === effectId ? { ...e, lut: asset.id } : e)) },
            ),
          },
    )
    return {
      ...p,
      luts: { ...(p.luts ?? {}), [asset.id]: asset },
      sequences: { ...p.sequences, [s.id]: { ...s, tracks } },
    }
  })
  return { ok: true, name }
}

/** Parse the text of a .cube file and load it into the effect. */
export function loadLutText(clipId: Id, effectId: Id, name: string, text: string): LutLoadResult {
  let cube: ParsedCube
  try {
    cube = parseCube(text)
  } catch (err) {
    return { ok: false, message: lutErrorMessage(err) }
  }
  return applyCubeToEffect(clipId, effectId, name, cube)
}

/**
 * Read a chosen file and load it into the effect. Shows the outcome as a toast as
 * well as returning it, so the Inspector can keep the same words next to the
 * button.
 */
export async function loadLutFile(clipId: Id, effectId: Id, file: File): Promise<LutLoadResult> {
  let result: LutLoadResult
  if (file.size > MAX_LUT_FILE_BYTES) {
    result = { ok: false, message: 'That file is too big to be a LUT (the most is 40 MB). Choose a .cube file.' }
  } else {
    let text: string | null = null
    try {
      text = await file.text()
    } catch {
      text = null
    }
    result =
      text === null
        ? { ok: false, message: 'That file could not be opened. Try choosing it again.' }
        : loadLutText(clipId, effectId, file.name, text)
  }
  useToasts.getState().show(result.ok ? `LUT loaded: ${result.name}` : result.message, result.ok ? 'success' : 'danger')
  return result
}
