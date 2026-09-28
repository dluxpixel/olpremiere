// `node scripts/make-app-icon.mjs` rebuilds the app icon: `build/icon.ico` (the
// desktop, the taskbar, the installer) and the phone's home screen icons in
// `public/` (icon-180/192/512.png).
//
// ⛔ HIS ASK, 2026-09-28: *"make the Melon logo bigger on the icon"*. Shown the
// melon filling its square next to the melon on its own, he picked the square,
// *"But make the background the same as the Almanac used to have"*: Almanac's
// tile was #1B1B1B with a corner of 56 on 256 and genuinely transparent corners
// (Desktop/l1fe history, scripts/make-icon.mjs, before 0d518de).
//
// Then, the same day, with the new icon on his taskbar: *"the melon is also just a
// tiny too big"*. At taskbar sizes the whole-pixel rule could only choose between
// a melon filling the tile edge to edge (2 px a melon pixel at 32) and one half as
// wide (1 px), so the melon is now drawn big with hard pixels and scaled down
// smoothly to the same share of the tile at EVERY size: SHARE below.
//
// The art is read from src/ui/melon.ts, the one place the melon is drawn, so the
// icon cannot drift from the splash and the topbar.
//
// Renders through the same Chromium the tests drive, so it needs no new dependency.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Almanac's tile. */
export const TILE = '#1B1B1B'
export const RADIUS = 56 / 256
/**
 * The melon's width as a share of the tile, at every size. 0.9375 (15 px a melon
 * pixel at 256) was "a tiny too big"; the cream icon before it was 0.875.
 */
export const SHARE = 0.85

const melonSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'melon.ts'), 'utf8')
const rowsBlock = /MELON_ROWS[^=]*=\s*\[([\s\S]*?)\]/.exec(melonSrc)[1]
const ROWS = [...rowsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
const paletteBlock = /MELON_PALETTE[^=]*=\s*\{([\s\S]*?)\}/.exec(melonSrc)[1]
const PALETTE = Object.fromEntries([...paletteBlock.matchAll(/(\w):\s*'(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]]))
const W = ROWS[0].length
const H = ROWS.length

/** The melon drawn with hard 32 px pixels, as a data URL, to be scaled down smoothly. */
function melonSheet() {
  const P = 32
  const cells = ROWS.flatMap((row, y) =>
    [...row].map((c, x) => (c === '.' ? '' : `<rect x="${x * P}" y="${y * P}" width="${P}" height="${P}" fill="${PALETTE[c]}"/>`)),
  ).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * P}" height="${H * P}" shape-rendering="crispEdges">${cells}</svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"></body></html>')
  const dataUrl = await page.evaluate(
    async ({ size, tile, radius, share, sheet, w, h }) => {
      const img = new Image()
      img.src = sheet
      await img.decode()
      // Scale the hard pixel sheet in halves, so no single step blurs more than it must.
      let src = document.createElement('canvas')
      src.width = img.width
      src.height = img.height
      src.getContext('2d').drawImage(img, 0, 0)
      const mw = size * share
      const mh = (mw * h) / w
      while (src.width / 2 > mw) {
        const half = document.createElement('canvas')
        half.width = Math.round(src.width / 2)
        half.height = Math.round(src.height / 2)
        const hx = half.getContext('2d')
        hx.imageSmoothingQuality = 'high'
        hx.drawImage(src, 0, 0, half.width, half.height)
        src = half
      }
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d')
      g.fillStyle = tile
      g.beginPath()
      g.roundRect(0, 0, size, size, size * radius)
      g.fill()
      g.imageSmoothingQuality = 'high'
      g.drawImage(src, (size - mw) / 2, (size - mh) / 2, mw, mh)
      return c.toDataURL('image/png')
    },
    { size, tile: TILE, radius: RADIUS, share: SHARE, sheet: melonSheet(), w: W, h: H },
  )
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

function packIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = Buffer.alloc(16 * pngs.length)
  let offset = 6 + 16 * pngs.length
  pngs.forEach(({ size, buf }, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += buf.length
  })
  return Buffer.concat([header, entries, ...pngs.map((p) => p.buf)])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const ico = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) ico.push({ size, buf: await render(page, size) })
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), packIco(ico))
  for (const size of [180, 192, 512]) fs.writeFileSync(path.join(ROOT, 'public', `icon-${size}.png`), await render(page, size))
  await browser.close()
  console.log('wrote build/icon.ico and public/icon-180/192/512.png')
}
