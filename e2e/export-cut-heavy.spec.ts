import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { shrinkSequence } from './exportHelpers'

// Export opens one demuxer plus one hardware decoder per CLIP, so a cut-heavy
// timeline used to end up holding 24 of them at half-second cuts and 46 at
// quarter-second cuts. A ProviderPool now closes the least recently used one
// past a ceiling of 8.
//
// The risk that buys is the one this spec exists to catch: if the pool ever
// closed a provider a later frame still needed, that layer would render with NO
// texture and the frame would come out BLACK. That is exactly the bug already
// shipped against at plain cuts, so it gets a real export, not a unit test.
// Cut one clip into more pieces than the ceiling, export, and look at the file.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/export-cut-heavy'
/** Comfortably above DEFAULT_MAX_LIVE_PROVIDERS, so the ceiling has to evict. */
const PIECES = 12

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

/** Razor the single imported clip into `pieces` on the video track. */
async function cutInto(page: Page, pieces: number): Promise<{ count: number; endS: number }> {
  return page.evaluate(async (pieces: number) => {
    const storeMod = '/src/state/store.ts'
    const timelineMod = '/src/engine/timeline.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { splitClip } = (await import(/* @vite-ignore */ timelineMod)) as {
      splitClip: (s: unknown, id: string, tS: number) => unknown
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => Seq
    }
    interface Clip {
      id: string
      startS: number
      inS: number
      outS: number
      speed: number
    }
    interface Seq {
      tracks: { kind: string; clips: Clip[] }[]
    }
    const videoClips = (s: Seq): Clip[] => s.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips)
    const lengthOf = (c: Clip): number => (c.outS - c.inS) / Math.max(Math.abs(c.speed) || 1, 1e-6)
    const first = videoClips(activeSequence(useStore.getState().project))[0]
    const endS = first.startS + lengthOf(first)
    const step = (endS - first.startS) / pieces
    updateActiveSequence('cut into pieces', (s) => {
      let out = s as Seq
      for (let i = 1; i < pieces; i++) {
        const tS = first.startS + i * step
        const target = videoClips(out).find((c) => tS > c.startS && tS < c.startS + lengthOf(c))
        if (target) out = splitClip(out, target.id, tS) as Seq
      }
      return out
    })
    return { count: videoClips(activeSequence(useStore.getState().project)).length, endS }
  }, pieces)
}

/** Brightest of the RGB channels at a fractional position, at output time tS. */
async function sampleAt(page: Page, b64: string, tS: number): Promise<number> {
  return page.evaluate(
    async ({ b64, tS }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error('decode failed'))
      })
      video.currentTime = tS
      await new Promise<void>((res) => {
        video.onseeked = () => res()
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)
      // Average the middle band rather than one pixel, so a dark subject does
      // not read as a dropped frame.
      const band = ctx.getImageData(0, Math.floor(canvas.height * 0.4), canvas.width, Math.floor(canvas.height * 0.2))
      let total = 0
      for (let i = 0; i < band.data.length; i += 4) {
        total += Math.max(band.data[i], band.data[i + 1], band.data[i + 2])
      }
      return total / (band.data.length / 4)
    },
    { b64, tS },
  )
}

test('a timeline cut into more pieces than the decoder ceiling exports without a black frame', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  const { count, endS } = await cutInto(page, PIECES)
  expect(count).toBe(PIECES)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(PIECES)

  await shrinkSequence(page)
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-open').click()
  const download = await dl
  const path = `${VERIFY}/out.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')

  // The FIRST frame of each piece is where a freshly opened or re-opened
  // provider is at its weakest, so sample there and just past there.
  const step = endS / PIECES
  const brightness: number[] = []
  for (let i = 0; i < PIECES; i++) {
    brightness.push(await sampleAt(page, b64, i * step + 0.01))
    brightness.push(await sampleAt(page, b64, i * step + step / 2))
  }
  const darkest = Math.min(...brightness)
  expect(brightness).toHaveLength(PIECES * 2)
  // Real picture, not an empty layer. The fixture is nowhere near black.
  expect(darkest).toBeGreaterThan(20)
})
