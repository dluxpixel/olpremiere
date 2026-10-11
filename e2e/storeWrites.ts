// Store writes from a spec, without a promise in the reply path.
//
// THE FLAKE THIS REMOVES. Under CPU load, an evaluate shaped like
//
//   await page.evaluate(async () => { const { useStore } = await import(storeMod); useStore.getState().setUI({ selection }) })
//
// sometimes failed with "Execution context was destroyed, most likely because of a navigation."
// No navigation happened and the app was in the right state afterwards. That text is Playwright's
// rewrite of the CDP error "Promise was collected": Playwright wraps an async result in a promise
// of its own, the V8 inspector holds that promise only weakly while it waits, and a GC that lands
// right after the big React render the write triggers loses the reply. Measured with a probe under
// load: the select written that way failed 1 of 24, and the same select run synchronously, with
// no promise to lose, failed 0 of 24.
//
// THE RULE. A plain, non-async evaluate returns a plain value, so there is nothing to collect.
// The dynamic import is async, but it writes nothing, so it is a step of its own that parks the
// modules on window. The write then runs in a synchronous evaluate that reads them:
//
//   await parkModules(page, ['/src/state/store.ts'])
//   await page.evaluate(() => {
//     const mods = (window as unknown as ParkedWindow).__e2eMods
//     const { useStore } = mods['/src/state/store.ts'] as { useStore: { getState: () => { setUI: (p: unknown) => void } } }
//     useStore.getState().setUI({ selection: [] })
//   })
//
// Reads (getState() with no write) may stay async. setUI and selectClips below cover the common case.
//
// THE GUARD. __e2eMods is a Proxy: reading a path that was never parked throws
// "e2e: <path> not parked, call parkModules first" instead of handing back undefined, so a
// missing parkModules line fails on the spot with its path named, not as a TypeError later.

import type { Page } from '@playwright/test'

const STORE = '/src/state/store.ts'

/** What parkModules leaves on window: each loaded module, under the path it was imported from. */
export interface ParkedWindow {
  /** Guarded: reading a path that was not parked throws, see THE GUARD above. */
  __e2eMods: Record<string, unknown>
}

/**
 * Loads app modules by their dev server paths (for example '/src/state/store.ts') and parks them on
 * window. It only imports. Do no store writes in here, that is the whole point of the split.
 */
export async function parkModules(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Partial<ParkedWindow>
    const parked =
      w.__e2eMods ??
      (w.__e2eMods = new Proxy({} as Record<string, unknown>, {
        get(target, key) {
          if (typeof key === 'string' && !(key in target)) throw new Error(`e2e: ${key} not parked, call parkModules first`)
          return Reflect.get(target, key)
        },
      }))
    for (const p of paths) parked[p] = await import(/* @vite-ignore */ p)
  }, paths)
}

/** ui.setUI(patch), written synchronously. */
export async function setUI(page: Page, patch: Record<string, unknown>): Promise<void> {
  await parkModules(page, [STORE])
  await page.evaluate((patch) => {
    const { useStore } = (window as unknown as ParkedWindow).__e2eMods['/src/state/store.ts'] as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI(patch)
  }, patch)
}

/** Select exactly these clips. An empty list clears the selection. */
export async function selectClips(page: Page, ids: string[]): Promise<void> {
  await setUI(page, { selection: ids })
}
