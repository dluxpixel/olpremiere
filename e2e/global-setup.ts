// Synthesizes the e2e media fixture once per machine: a 2s 320x180 WebM
// (red for t<1s, blue after, 440Hz tone) recorded with MediaRecorder in
// headless Chrome. Keeps binary fixtures out of the repo.

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURE_PATH = path.join('e2e', '.fixtures', 'clip.webm')

export default async function globalSetup(): Promise<void> {
  if (fs.existsSync(FIXTURE_PATH)) return
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  try {
    const page = await browser.newPage()
    const b64 = await page.evaluate(async () => {
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
          c2d.fillStyle = t < 1 ? '#e63946' : '#2b6cb0'
          c2d.fillRect(0, 0, 320, 180)
          c2d.fillStyle = '#ffffff'
          c2d.font = '24px sans-serif'
          c2d.fillText(t.toFixed(2), 20, 40)
          if (t >= 2) {
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
    })
    fs.writeFileSync(FIXTURE_PATH, Buffer.from(b64, 'base64'))
  } finally {
    await browser.close()
  }
}
