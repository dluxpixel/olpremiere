// Synthesizes the e2e media fixtures once per machine, recorded with
// MediaRecorder in headless Chrome, so no binary fixtures live in the repo:
//  - clip.webm:       2s 320x180, red for t<1s then blue, 440Hz tone.
//  - greenscreen.webm: 1s 320x180 pure-green screen with a white centre block +
//    a thin white vertical line, for the chroma-key white-edge test.

import { chromium, type Page } from '@playwright/test'
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

export default async function globalSetup(): Promise<void> {
  if (fs.existsSync(FIXTURE_PATH) && fs.existsSync(GREENSCREEN_FIXTURE_PATH)) return
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  try {
    const page = await browser.newPage()
    await synthesize(page, FIXTURE_PATH, 2, 'clip')
    await synthesize(page, GREENSCREEN_FIXTURE_PATH, 1, 'greenscreen')
  } finally {
    await browser.close()
  }
}
