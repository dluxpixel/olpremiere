import type { Page } from '@playwright/test'

/**
 * Shrink the sequence so a test export encodes in seconds.
 *
 * Export has no settings any more: one button, and the app picks everything.
 * The raster follows the SEQUENCE (and a sub-HD sequence is never upscaled), so
 * this is how a spec asks for a small file. It used to pick "SD" in a dropdown
 * that no longer exists. Refit is off: the clips must stay exactly as the test
 * placed them.
 */
export async function shrinkSequence(page: Page, width = 640, height = 360): Promise<void> {
  await page.evaluate(
    async ({ w, h }) => {
      const storeMod = '/src/state/store.ts'
      const { setActiveSequenceFormat } = (await import(/* @vite-ignore */ storeMod)) as {
        setActiveSequenceFormat: (w: number, h: number, refit?: boolean) => void
      }
      setActiveSequenceFormat(w, h, false)
    },
    { w: width, h: height },
  )
}

