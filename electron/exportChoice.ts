// Where a page may have main write a movie: only where HE said, in main's own save dialog.
//
// ⛔ ffmpeg writes with -y, so a destination the page could simply name would let any
// page code overwrite any file on his PC with a movie. Until 2026-10-07 main therefore
// threw away every destination a page sent (main.ts native:start) and asked him itself.
//
// ⛔ BUT THE PAGE DOES CARRY HIS ANSWER BACK. Since the export audit of 2026-10-06 the
// export asks where to save BEFORE it makes the sound (main's native:pickOutput: a
// dialog dismissed after the mix had been rendered threw the mix away), keeps the
// answer, and hands it to native:start. A restart (the Platform loudness switch) and
// Try again send the same answer again without asking. Throwing it away made every
// desktop export ask twice, the second time after the sound was already made.
//
// ⛔ SO IT IS ONE SLOT FOR THE WHOLE EXPORT JOB, NOT A ONE USE PASS. Main keeps the
// answer its own dialog gave, and takes a destination from a page only when it is
// exactly that answer, as many times as the job starts: the loudness switch restarts by
// cancelling and starting again, and Try again starts again after a failure, both with
// the same answer. The job ends with a finished movie, which clears the slot, and his
// next answer in a dialog replaces it. Anything else is dropped, and main asks him
// itself, as before.

import path from 'node:path'

/** His answer to the export save dialog, for the export job it was asked for. */
let chosen: string | null = null

/** He chose this file in an export save dialog (saveFiles.rememberFolder calls this). */
export function choseExportPath(filePath: string): void {
  chosen = path.resolve(filePath)
}

/**
 * The destination a page asked for, when it is the file he chose for this export job.
 * Otherwise undefined, and the export asks him itself.
 */
export function exportPathFromPage(asked: unknown): string | undefined {
  if (typeof asked !== 'string' || asked === '' || chosen === null) return undefined
  return path.resolve(asked) === chosen ? chosen : undefined
}

/**
 * native:finish answered (main.ts). A finished movie ends the job: the slot is cleared
 * and the next export asks again. A failed one keeps it, for Try again. A cancel never
 * comes here and keeps it too, because main cannot tell his own cancel from the
 * loudness switch's restart; his next dialog answer replaces it either way.
 */
export function exportFinished(done: unknown): void {
  if (done && typeof done === 'object' && (done as { ok?: unknown }).ok === true) chosen = null
}
