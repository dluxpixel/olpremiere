// The proxy folder's temp-file sweep, kept in its OWN file with no `electron`
// import, so it can be unit tested against a real directory. It deletes files,
// which is exactly the kind of code that must be proven not to delete anything
// else.

import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Is this a leftover from a proxy build rather than something that matters?
 *
 * Only the two names `beginProxy` creates: `in-<uuid>` for the streamed source
 * and `out-<uuid>.mp4` for the transcode. **Anything else in the folder is left
 * alone**, so a future cache, a manifest or a file he put there by hand survives
 * a sweep it was never meant to include.
 */
export const isProxyTemp = (name: string): boolean => name.startsWith('in-') || name.startsWith('out-')

/**
 * Delete proxy temp files in `dir`. Returns how many went.
 *
 * ⛔ CALL THIS AT STARTUP ONLY. A temp belongs to a build in flight until that
 * build finishes, so sweeping while one is running would pull the file out from
 * under ffmpeg. At startup there are none.
 *
 * Never throws: tidying up must not be the thing that stops the app opening. A
 * missing folder is simply nothing to do.
 */
export async function sweepProxyDir(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!isProxyTemp(name)) continue
    let failed = false
    await rm(path.join(dir, name), { force: true }).catch(() => {
      failed = true
    })
    if (!failed) removed++
  }
  return removed
}
