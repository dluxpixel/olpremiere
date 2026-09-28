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
// The art is read from src/ui/melon.ts, the one place the melon is drawn, so the
// icon cannot drift from the splash and the topbar. Every size gets WHOLE pixels:
// pixel art scaled by 1.875 is a smear, so each size picks the whole number of
// screen pixels per melon pixel that fills the tile best.
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
/** The melon's width as a share of the tile at 256: 15 px per melon pixel, was 14 on cream. */
export const FILL = 15 / 256

const melonSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'melon.ts'), 'utf8')
const rowsBlock = /MELON_ROWS[^=]*=\s*\[([\s\S]*?)\]/.exec(melonSrc)[1]
const ROWS = [...rowsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
const paletteBlock = /MELON_PALETTE[^=]*=\s*\{([\s\S]*?)\}/.exec(melonSrc)[1]
const PALETTE = Object.fromEntries([...paletteBlock.matchAll(/(\w):\s*'(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]]))
const W = ROWS[0].length
const H = ROWS.length

export function iconSvg(size) {
  const px = Math.max(1, Math.round(size * FILL))
  const mw = W * px
  const mh = H * px
  const x0 = Math.floor((size - mw) / 2)
  const y0 = Math.floor((size - mh) / 2)
  const r = Math.round(size * RADIUS)
  const cells = ROWS.flatMap((row, y) =>
    [...row].map((c, x) =>
      c === '.' ? '' : `<rect x="${x0 + x * px}" y="${y0 + y * px}" width="${px}" height="${px}" fill="${PALETTE[c]}"/>`,
    ),
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${r}" fill="${TILE}"/><g shape-rendering="crispEdges">${cells}</g></svg>`
}

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(size)}</body></html>`)
  return page.screenshot({ omitBackground: true })
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
