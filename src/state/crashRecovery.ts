// The editor's half of a crash: main loads a page that died again (electron/crashPlan.ts),
// and this new page tells him why it just blinked, instead of leaving him to wonder
// whether his work went with it.

import type { OlApi } from '../../electron/ipc-types'
import { useToasts } from './toasts'

export const CRASH_RECOVERED_TOAST = 'Something went wrong, so OL Premiere opened again. Your work up to the last save is safe'

/** Ask main once, on mount, and say so if this page is the one after a crash. */
export async function announceCrashRecovery(api: Pick<OlApi, 'takeCrashRecovered'> | undefined): Promise<boolean> {
  let recovered = false
  try {
    recovered = (await api?.takeCrashRecovered?.()) === true
  } catch {
    return false // an older shell without the call: nothing to say
  }
  if (recovered) useToasts.getState().show(CRASH_RECOVERED_TOAST, 'info', undefined, { durationMs: 12_000 })
  return recovered
}
