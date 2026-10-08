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
// So main keeps the answer its own dialog gave, and takes a destination from a page
// only when it is exactly that answer. It is spent once a finished movie has been
// written there, and his next answer replaces it. Anything else is dropped, and main
// asks him itself, as before.

import path from 'node:path'

/** His last answer to an export save dialog, not yet written to. */
let chosen: string | null = null

/** He chose this file in an export save dialog (saveFiles.rememberFolder calls this). */
export function choseExportPath(filePath: string): void {
  chosen = path.resolve(filePath)
}

/**
 * The destination a page asked for, when it is the file he last chose in an export
 * save dialog. Otherwise undefined, and the export asks him itself.
 */
export function exportPathFromPage(asked: unknown): string | undefined {
  if (typeof asked !== 'string' || asked === '' || chosen === null) return undefined
  return path.resolve(asked) === chosen ? chosen : undefined
}

/** A finished movie was written there: that answer has been used. */
export function exportPathUsed(filePath: unknown): void {
  if (typeof filePath === 'string' && chosen !== null && path.resolve(filePath) === chosen) chosen = null
}
