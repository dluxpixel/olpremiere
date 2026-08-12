// The headroom ceiling, kept out of the React tree so it is unit-testable on its
// own. The same split motionRuler.ts makes for the rail and monitorSizing.ts for
// the program monitor.
//
// ⛔ THIS FILE USED TO BE `punchPresets.ts` AND MOST OF IT WAS DEAD, 2026-08-12.
// It carried the saved zoom chips: a storage key, a shape, a read-forward shim
// for the bare numbers his browser filled months ago, a save and a load. Its
// header promised "a preset he saved months ago keeps working". **Nothing had
// called `loadPresets` since v0.1.55 replaced the motion desk with the move
// shelf**, so that promise had already been broken by the rewrite and only the
// unit tests were keeping the code looking alive. Two constants in it had drifted
// out of step with the slider that replaced them (1.01 to 4 here, 1.05 to 2
// there) under a comment claiming they matched.
//
// The dead half was deleted rather than resynced. **His storage key was NOT
// touched**, so the numbers are still sitting in his browser if the chips ever
// come back.

/**
 * How far this clip can be pushed before the punch is upscaling: the source's
 * own width over the sequence's. 4K into a 1080p sequence is 200 percent;
 * native 1080p is 100 percent, which means every punch on it is already soft.
 *
 * Null when there is no source width to divide by (a title, an audio clip), and
 * a number nobody can stand behind is worse than no number at all.
 */
export function headroomCeiling(assetWidth: number | undefined, seqWidth: number): number | null {
  if (typeof assetWidth !== 'number' || !Number.isFinite(assetWidth) || assetWidth <= 0) return null
  if (!Number.isFinite(seqWidth) || seqWidth <= 0) return null
  return assetWidth / seqWidth
}

/**
 * Past the ceiling the picture is being upscaled and starts to soften. Nothing
 * stops him punching a 1080p source to 170 percent today, and the softness only
 * turns up on export. This WARNS. It never blocks: an upscaled punch is a real
 * choice, and on a shot he needs it is the right one.
 */
export const overHeadroom = (depth: number, ceiling: number | null): boolean =>
  ceiling !== null && depth > ceiling + 5e-3
