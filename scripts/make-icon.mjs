// Render public/icon.svg to a multi-resolution Windows .ico via headless
// Chromium (no image libraries needed). Produces public/ot-premiere.ico +
// public/favicon.png. Run: node scripts/make-icon.mjs
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svg = fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf8')
const sizes = [16, 24, 32, 48, 64, 128, 256]

const browser = await chromium.launch()
const page = await browser.newPage()
const pngs = []
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<!doctype html><html><body style="margin:0">` +
      `<div style="width:${size}px;height:${size}px">${svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)}</div>` +
      `</body></html>`,
  )
  const buf = await page.screenshot({ omitBackground: true })
  pngs.push({ size, buf })
}
await browser.close()

// Pack PNG images into an .ico (PNG-in-ICO is valid on Windows Vista+).
const count = pngs.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(count, 4)

const entries = Buffer.alloc(16 * count)
let offset = 6 + 16 * count
const dataChunks = []
pngs.forEach((p, i) => {
  const e = entries.subarray(i * 16, i * 16 + 16)
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0) // width (0 = 256)
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(p.buf.length, 8) // size of image data
  e.writeUInt32LE(offset, 12) // offset
  offset += p.buf.length
  dataChunks.push(p.buf)
})

const ico = Buffer.concat([header, entries, ...dataChunks])
fs.writeFileSync(path.join(root, 'public', 'ot-premiere.ico'), ico)
fs.writeFileSync(path.join(root, 'public', 'favicon.png'), pngs.find((p) => p.size === 64).buf)
console.log(`wrote public/ot-premiere.ico (${sizes.join('/')}) — ${ico.length} bytes`)
