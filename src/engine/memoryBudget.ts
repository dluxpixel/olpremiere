// How much RAM the caches are allowed to take, decided from the machine instead
// of from three numbers somebody typed once.
//
// ⛔ MEASURED ON HIS MACHINE, 2026-08-24, WITH OL PREMIERE NOT RUNNING:
//   Available 7.6 GB, Total 31.7 GB, **Committed 47.1 GB**.
// The commit charge was 15 GB past physical RAM before the editor was even open,
// so Windows was already paging. That is the mechanism behind his *"it just
// sometimes stutters and it just fucking lags for a minute"*: a page fault storm
// stalls everything and does not care which process asked for the page.
//
// Against that, the app declared 512 MB of frames + 256 MB of audio + 192 MB of
// denoise = 960 MB, as constants, with no idea whether the machine had 32 GB free
// or 2. Each of those numbers is defensible on an idle machine and all three
// together are a large bite out of 7.6 GB.
//
// So the budget is a SHARE of what is actually available, with the old numbers as
// the ceiling. It can never ask for more than it used to; on a machine under
// pressure it asks for a great deal less.
//
// ⚠️ THE TOTAL IS WHAT MATTERS, NOT THE SPLIT. The three caches were tuned
// against each other (a frame is expensive to rebuild, a stretched slice is
// cheap), so the split is kept exactly as it was and only the total moves.

/** What the app used to take, unconditionally. Also the ceiling now. */
export const CEILING_BYTES = 960 * 1024 * 1024

/**
 * The share of AVAILABLE memory the caches may hold.
 *
 * A third sounds bold and is not: the alternative to caching a decoded frame is
 * decoding it again on the next rAF, which is far more expensive than the page it
 * would have cost. What the fraction protects against is the case where a third
 * of available is a small number, which is exactly the case that was going wrong.
 */
const SHARE = 1 / 3

/** Below this the app is in trouble whatever it does; stop taking from it. */
const FLOOR_BYTES = 96 * 1024 * 1024

export interface CacheBudgets {
  /** Decoded video frames. The most expensive thing here to rebuild. */
  frames: number
  /** Decoded audio buffers, forward and reversed. */
  audio: number
  /** Denoised and mixed channel data, two full copies per asset. */
  denoise: number
  /** The sum, which is the number that has to fit on the machine. */
  total: number
}

/** The old split, held exactly: 512 / 256 / 192 of 960. */
const SPLIT = { frames: 512 / 960, audio: 256 / 960, denoise: 192 / 960 }

/**
 * Budgets for a machine with `availableBytes` of memory going spare.
 *
 * Pass 0 or anything unusable and you get the old constants back, because a
 * number nobody can stand behind must never make the app worse than it was.
 */
export function cacheBudgets(availableBytes: number): CacheBudgets {
  const usable =
    Number.isFinite(availableBytes) && availableBytes > 0
      ? Math.min(CEILING_BYTES, Math.max(FLOOR_BYTES, Math.floor(availableBytes * SHARE)))
      : CEILING_BYTES
  return {
    frames: Math.floor(usable * SPLIT.frames),
    audio: Math.floor(usable * SPLIT.audio),
    denoise: Math.floor(usable * SPLIT.denoise),
    total: usable,
  }
}

/**
 * What the renderer can find out about the machine on its own.
 *
 * ⚠️ `navigator.deviceMemory` IS CAPPED AT 8 BY THE SPEC and reports TOTAL, not
 * free, so on his 32 GB machine it says 8 and on a 4 GB one it says 4. It is a
 * poor instrument and it is the only one a sandboxed renderer has, so it is used
 * as a FLOOR: half of what it reports, which lands at 4 GB for any machine with
 * 8 GB or more. The real number comes from the main process when it can, through
 * `setAvailableMemory` below.
 */
function rendererGuessBytes(): number {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0) return 0
  return (gb / 2) * 1024 * 1024 * 1024
}

let availableBytes = 0

/**
 * Tell the budget what the machine actually has spare. Main knows this properly
 * (`process.getSystemMemoryInfo`); the renderer only ever gets to guess.
 *
 * Safe to call repeatedly: the caches read `budgets()` when they evict, so a
 * later, better number simply applies from the next eviction on.
 */
export function setAvailableMemory(bytes: number): void {
  availableBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
}

/** The budgets in force right now. */
export function budgets(): CacheBudgets {
  return cacheBudgets(availableBytes || rendererGuessBytes())
}

/** How often the machine is asked again. Cheap, and pressure moves slowly. */
const POLL_MS = 60_000

/**
 * Ask the main process what the machine actually has spare, now and every minute.
 *
 * ⚠️ FREE, NOT TOTAL. What the caches have to fit inside is what is spare while
 * he is running Brave, Discord, Spotify and the rest, not what the sticks add up
 * to. Measured on his machine with the editor closed: 7.6 GB spare of 31.7 GB
 * total. Sizing against the total is how a fixed 960 MB looked reasonable.
 *
 * No-ops in a browser or a test, where there is no main process to ask; the
 * `deviceMemory` guess stands in and the ceiling is unchanged from what shipped.
 */
export function watchSystemMemory(): () => void {
  const api = (globalThis as { api?: { systemMemory?: () => Promise<{ freeKb: number }> } }).api
  if (typeof api?.systemMemory !== 'function') return () => {}
  const ask = (): void => {
    void api
      .systemMemory?.()
      .then((m) => setAvailableMemory(m.freeKb * 1024))
      .catch(() => undefined)
  }
  ask()
  const timer = setInterval(ask, POLL_MS)
  return () => clearInterval(timer)
}
