import { expect, test } from '@playwright/test'

// ⛔ THE ONE THAT MUST NEVER GO QUIET AGAIN.
//
// 2026-08-23: his database threw itself away and took the only copy of his
// footage with it. The mirror gives the bytes a second home and the app repairs
// itself from it on launch. He opened the first build carrying that and got a
// banner saying his media was gone instead, because the repair swallowed its own
// failure. Two more of his days went on that.
//
// So this drives the whole thing in a real browser against a stand-in for the
// desktop shell: import, mirror, take the database copy away, reload, and the
// edit must come back on its own with nothing clicked.

const FIXTURE = 'e2e/.fixtures/clip.webm'

/**
 * A stand-in desktop shell that implements the media mirror AND NOTHING ELSE.
 *
 * ⛔ IT DOES NOT CLAIM `isElectron`, ON PURPOSE. Saying that has the boot
 * sequence, the updater and the backups panel all reach for calls that are not
 * here, and the app never finishes loading. `mirrorApi()` asks for the METHODS
 * rather than the flag for exactly this reason: the methods are the capability,
 * and a path nothing can stand in for is a path taken on trust.
 */
const FAKE_SHELL = `
  // ⛔ THE FAKE DISK HAS TO SURVIVE A RELOAD, or this proves nothing: an init
  // script re-runs on every navigation, so an in-memory Map is empty again by the
  // time the repair looks, and the test fails for a reason the app never had.
  const KEY = 'e2e:fake-media-disk'
  const load = () => {
    const raw = localStorage.getItem(KEY)
    if (!raw) return new Map()
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, Uint8Array.from(atob(v), c => c.charCodeAt(0))]))
  }
  const save = () => {
    const out = {}
    for (const [k, v] of disk) out[k] = btoa(String.fromCharCode(...v))
    localStorage.setItem(KEY, JSON.stringify(out))
  }
  const disk = load()
  window.__disk = disk
  window.api = {
    mediaList: async () => [...disk].map(([id, b]) => ({ id, size: b.length })),
    mediaBegin: async (id) => { disk.set(id, new Uint8Array(0)); return true },
    mediaChunk: async (id, bytes) => {
      const prev = disk.get(id) ?? new Uint8Array(0)
      const next = new Uint8Array(prev.length + bytes.byteLength)
      next.set(prev); next.set(new Uint8Array(bytes), prev.length)
      disk.set(id, next)
    },
    mediaFinish: async (id) => { save(); return (disk.get(id) ?? []).length },
    mediaCancel: async (id) => { disk.delete(id) },
    mediaRead: async (id, off, len) => {
      const b = disk.get(id)
      return b ? b.slice(off, off + len).buffer : null
    },
    mediaDelete: async (id) => { disk.delete(id); save() },
  }
`

// ⛔ Passed INTO the page, never closed over: an evaluate body runs in the
// browser and cannot see anything declared out here.
const MODS = { store: '/src/state/store.ts', persist: '/src/state/persistence.ts' }

test('an edit whose media the database lost comes back on its own', async ({ page }) => {
  await page.addInitScript(FAKE_SHELL)
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()

  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // The import mirrors it. Wait for the copy rather than assuming the timing.
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __disk: Map<string, unknown> }).__disk.size), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0)

  // Save first: without this the reload opens a fresh project and the test would
  // be measuring nothing. (That caught me once already.)
  const before = await page.evaluate(async (m: { store: string; persist: string }) => {
    interface Doc {
      assets: Record<string, { id: string; name: string; blobKey: string }>
      sequences: Record<string, { tracks: { clips: unknown[] }[] }>
    }
    const { useStore } = (await import(/* @vite-ignore */ m.store)) as {
      useStore: { getState: () => { project: Doc } }
    }
    const { saveProject, deleteBlob } = (await import(/* @vite-ignore */ m.persist)) as {
      saveProject: (p: unknown) => Promise<void>
      deleteBlob: (k: string) => Promise<void>
    }
    const p = useStore.getState().project
    await saveProject(p)
    const a = Object.values(p.assets)[0]
    // ⛔ Exactly what a rebuilt store does: the record stays, the bytes go.
    await deleteBlob(a.blobKey)
    const clips = Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))
    return { id: a.id, blobKey: a.blobKey, clipCount: clips.length }
  }, MODS)

  await page.reload()
  await expect(page.getByTestId('panel-left')).toBeVisible()

  // ⛔ NOTHING IS CLICKED. The repair runs on its own and the bytes come back
  // UNDER THE SAME KEY.
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (a: { persist: string; key: string }) => {
            const { getBlob } = (await import(/* @vite-ignore */ a.persist)) as {
              getBlob: (k: string) => Promise<Blob | null>
            }
            return (await getBlob(a.key))?.size ?? 0
          },
          { persist: MODS.persist, key: before.blobKey },
        ),
      { timeout: 30_000, intervals: [1000] },
    )
    .toBeGreaterThan(0)

  // And he is never asked to find anything, because there is nothing to ask for.
  await expect(page.getByTestId('find-my-media')).toHaveCount(0)

  const after = await page.evaluate(async (m: { store: string; persist: string }) => {
    interface Doc {
      assets: Record<string, { id: string; blobKey: string }>
      sequences: Record<string, { tracks: { clips: { assetId: string }[] }[] }>
    }
    const { useStore } = (await import(/* @vite-ignore */ m.store)) as {
      useStore: { getState: () => { project: Doc } }
    }
    const p = useStore.getState().project
    const a = Object.values(p.assets)[0]
    const clips = Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))
    return { id: a.id, blobKey: a.blobKey, clipCount: clips.length }
  }, MODS)

  // Nothing in the edit moved.
  expect(after.id).toBe(before.id)
  expect(after.blobKey).toBe(before.blobKey)
  expect(after.clipCount).toBe(before.clipCount)
})
