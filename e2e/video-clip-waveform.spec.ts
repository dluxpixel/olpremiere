import { expect, test, type Page } from '@playwright/test'

// A VIDEO CLIP THAT PLAYS ITS OWN SOUND NOW DRAWS IT.
//
// The app already knew these clips have audio: `clipShowsOwnWaveform` defers to
// `clipEmitsAudioOn`, the rule the mixer, the export and the Inspector's Audio
// section all use, and it says a video-track clip is audible when it has no
// linked audio partner. The timeline was the one place that did not say so, and
// he cuts to sound.
//
// ⛔ THIS IS NOT "WAVEFORMS ON VIDEO CLIPS". A clip with a linked audio partner
// has its sound drawn on that partner already, and `phase6.spec.ts` pins that
// it must stay undrawn here. Saying it twice would imply two sources where
// there is one. The other three ways it stays undrawn (audio track, silent
// asset, title/adjustment) are unit-tested in `engine/audio.test.ts`, which
// needs no fixture and no browser.
//
// THE CASE IS REACHABLE, and that was checked before this was built:
// `addClipWithLinkedAudio` takes the first UNLOCKED audio track, and with none
// available its own comment reads "No audio track: standalone video clip keeps
// its own audio (no linkId)". Locking the audio lanes is how he gets there.

const FIXTURE = 'e2e/.fixtures/clip.webm'

const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')
const aclip = (page: Page) => page.locator('[data-clip-kind="audio"]')

async function lockAudioTracks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The path goes through a variable so this stays a runtime import: naming it
    // inline makes the renderer typecheck try to resolve a served URL as a
    // module. Same shape as `safety.spec.ts`.
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    updateActiveSequence('lock audio', (s) => {
      const sq = s as { tracks: { kind: string; locked: boolean }[] }
      return { ...sq, tracks: sq.tracks.map((t) => (t.kind === 'audio' ? { ...t, locked: true } : t)) }
    })
  })
}

/** Opaque pixels in the canvas, so a blank waveform can never pass silently. */
async function paintedPixels(page: Page): Promise<number> {
  return vclip(page)
    .getByTestId('clip-waveform')
    .evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext('2d')
      if (!ctx || el.width === 0 || el.height === 0) return 0
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      let n = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++
      return n
    })
}

/**
 * Is the waveform band painted ABOVE the clip's imagery, or merely painted?
 *
 * ⛔ THE PIXEL COUNT ABOVE CANNOT ANSWER THIS, and that is the whole reason this
 * exists. The filmstrip is a later absolutely-positioned sibling covering the
 * clip edge to edge, so with both at `z-index: auto` the browser paints it
 * straight over a fully-drawn waveform. `getImageData` reads the canvas's own
 * backing store and is perfectly happy either way: the feature would have
 * shipped invisible with a green test behind it.
 *
 * Both elements are positioned siblings in one stacking context, so the rule is
 * z-index first and DOM order only to break a tie.
 */
async function bandPaintsOverImagery(page: Page): Promise<{ hasImagery: boolean; above: boolean; z: number }> {
  return vclip(page).evaluate((clipEl: HTMLElement) => {
    const canvas = clipEl.querySelector('[data-testid="clip-waveform"]')
    const band = canvas?.parentElement
    if (!band) return { hasImagery: false, above: false, z: 0 }
    const zOf = (el: Element): number => {
      const v = parseInt(getComputedStyle(el).zIndex, 10)
      return Number.isNaN(v) ? 0 : v
    }
    const z = zOf(band)
    const img = clipEl.querySelector('img')
    if (!img) return { hasImagery: false, above: z > 0, z }
    const kids = Array.from(clipEl.children)
    const zi = zOf(img)
    return { hasImagery: true, above: z === zi ? kids.indexOf(band) > kids.indexOf(img) : z > zi, z }
  })
}

test('a video clip with no audio partner draws its own waveform', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // Lock every audio lane BEFORE the drop, so the video lands with its own
  // sound rather than as a linked pair. Set through the store, the way
  // `safety.spec.ts` already locks a track: the lock button is not what this
  // spec is about, and driving it here would make a waveform test fail for a
  // reason in the track header.
  await lockAudioTracks(page)

  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
  // The whole premise: no audio clip was made, so nothing else draws this sound.
  await expect(aclip(page)).toHaveCount(0)

  const wave = vclip(page).getByTestId('clip-waveform')
  await expect(wave).toHaveCount(1)

  // AND IT REALLY PAINTS. A canvas that exists and is blank is the failure this
  // feature would have shipped with if the peaks never decoded for a video
  // asset, and it would have looked identical in a screenshot of the DOM.
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(50)

  // AND HE CAN ACTUALLY SEE IT. Held separately from the pixel count on purpose:
  // this is the assertion that goes red when the filmstrip covers the band.
  const order = await bandPaintsOverImagery(page)
  expect(order.z).toBeGreaterThan(0)
  expect(order.above).toBe(true)

  // The clip's own imagery must still be there underneath. A band that wins by
  // being the only thing drawn is not the fix: the waveform sits in a bottom
  // strip so the frames above it still read.
  await expect(vclip(page).locator('img')).toHaveCount(1)
  expect(order.hasImagery).toBe(true)
})
