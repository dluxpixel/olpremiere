// Synthesizes the e2e media fixtures once per machine, recorded with
// MediaRecorder in headless Chrome, so no binary fixtures live in the repo:
//  - clip.webm:       2s 320x180, red for t<1s then blue, 440Hz tone.
//  - greenscreen.webm: 1s 320x180 pure-green screen with a white centre block +
//    a thin white vertical line, for the chroma-key white-edge test.

import { chromium, type Browser, type FullConfig, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const FIXTURES_DIR = path.join('e2e', '.fixtures')
export const FIXTURE_PATH = path.join(FIXTURES_DIR, 'clip.webm')
export const GREENSCREEN_FIXTURE_PATH = path.join(FIXTURES_DIR, 'greenscreen.webm')

/**
 * Record a `durationS`-second 320x180 WebM whose frames are painted per `kind`,
 * with a 440Hz tone, and write it to `outPath`. Skips if the file already exists.
 */
async function synthesize(page: Page, outPath: string, durationS: number, kind: 'clip' | 'greenscreen'): Promise<void> {
  if (fs.existsSync(outPath)) return
  const b64 = await page.evaluate(
    async ({ durationS, kind }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      const c2d = canvas.getContext('2d')!
      const stream = canvas.captureStream(30)

      const actx = new AudioContext()
      const osc = actx.createOscillator()
      osc.frequency.value = 440
      const gain = actx.createGain()
      gain.gain.value = 0.2
      const dest = actx.createMediaStreamDestination()
      osc.connect(gain).connect(dest)
      osc.start()
      const audioTrack = dest.stream.getAudioTracks()[0]
      if (audioTrack) stream.addTrack(audioTrack)

      const drawFrame = (t: number): void => {
        if (kind === 'clip') {
          c2d.fillStyle = t < 1 ? '#e63946' : '#2b6cb0'
          c2d.fillRect(0, 0, 320, 180)
          c2d.fillStyle = '#ffffff'
          c2d.font = '24px sans-serif'
          c2d.fillText(t.toFixed(2), 20, 40)
        } else {
          // Pure-green screen with white detail: a centre block (0.5,0.5) and a
          // thin vertical line, which are the white corners/lines that must survive keying.
          c2d.fillStyle = '#00ff00'
          c2d.fillRect(0, 0, 320, 180)
          c2d.fillStyle = '#ffffff'
          c2d.fillRect(155, 0, 10, 180)
          c2d.fillRect(130, 70, 60, 40)
        }
      }

      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve()
      })
      rec.start(100)

      const t0 = performance.now()
      await new Promise<void>((resolve) => {
        const draw = () => {
          const t = (performance.now() - t0) / 1000
          drawFrame(t)
          if (t >= durationS) {
            resolve()
            return
          }
          requestAnimationFrame(draw)
        }
        draw()
      })

      rec.stop()
      osc.stop()
      await stopped
      const blob = new Blob(chunks, { type: 'video/webm' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < bytes.length; i += 32768) {
        s += String.fromCharCode(...bytes.subarray(i, i + 32768))
      }
      return btoa(s)
    },
    { durationS, kind },
  )
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'))
}

/**
 * Open the app once and wait for the editor, so the dev server's cold compile is
 * paid HERE and not by whichever test happens to run first.
 *
 * ⛔ THE FIRST TEST OF EVERY RUN USED TO PAY IT: 4.1 s on 2026-08-20, then 10.8,
 * 24.4 s on the v3.22.0 gate, and a 60 s timeout (red) on 2026-10-04's first ship.
 * Test two of the same file takes 2 to 3 s. Playwright starts the webServer before
 * globalSetup, so the server is up when this runs. 120 s, because this is not a
 * test: it is the one wait that is allowed to be slow.
 */
async function warmDevServer(browser: Browser, baseURL: string): Promise<void> {
  const t0 = Date.now()
  const page = await browser.newPage({ baseURL, viewport: { width: 1600, height: 900 } })
  try {
    await page.goto('/', { timeout: 120_000 })
    await page.getByTestId('panel-left').waitFor({ timeout: 120_000 })
  } catch (e) {
    throw new Error(`the dev server at ${baseURL} never served a working editor within 120 s, so no spec could pass: ${String(e)}`)
  } finally {
    await page.close()
  }
  console.log(`[global setup] dev server warmed: the editor mounted in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  const needFixtures = !(fs.existsSync(FIXTURE_PATH) && fs.existsSync(GREENSCREEN_FIXTURE_PATH))
  if (needFixtures) fs.mkdirSync(FIXTURES_DIR, { recursive: true })

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  try {
    if (needFixtures) {
      const page = await browser.newPage()
      await synthesize(page, FIXTURE_PATH, 2, 'clip')
      await synthesize(page, GREENSCREEN_FIXTURE_PATH, 1, 'greenscreen')
      await page.close()
    }
    if (baseURL) await warmDevServer(browser, baseURL)
  } finally {
    await browser.close()
  }
}
