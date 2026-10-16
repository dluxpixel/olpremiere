// EVERY FRAME SHAPE EXPORTS, ENDS, AND IS NO SLOWER PER PIXEL THAN 9:16 (2026-10-16)
//
// Why this exists: on 2026-10-15 a Phone (1080 x 2112) export of seven iPhone clips crawled at about
// 1 frame a second and looked hung at 22%, while the same project at 9:16 ran at full speed. No
// check exported anything but the sequence's own small test shapes, so a shape could fall off a
// cliff and the release still shipped. This drives the REAL desktop app (electron, the native
// ffmpeg export, the HDR master an iPhone clip gets on import) once per shape the export offers.
//
// The cause it guards against: the export worker keeps each title as a full frame canvas in a 48 MiB
// cache (src/engine/render/titleRaster.ts). Six titles at 1080 x 1920 fit; at 1080 x 2112 only five
// do, so with six on screen every title was drawn and uploaded again on every frame. That is why the
// project here carries six caption style titles: it is the load that showed it.
//
// What it checks, for every shape in FORMATS (read from the app, never a copied list) plus an SDR
// clip at 9:16 as a control:
//   - the export ENDS with the done outcome inside a hard limit, never a silent hang
//   - the file has the shape's width and height, the expected frame count, and an audio stream
//   - its speed (the app's own fpsMade from the usage log, per pixel for a shape bigger than 9:16 and
//     per frame for a smaller one) is within MAX_SLOWER of the 1080 x 1920 HDR export in the SAME
//     run. A ratio, never a fixed number, so a slow or busy machine moves every shape together and
//     only a shape that falls apart fails.
//
// Everything it writes goes under os.tmpdir(): the release gate fails if the tree changes.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FORMATS } from '../src/components/frameFormats'
import { runFfmpeg, runsWithFfmpeg } from './exportHelpers'
import { parkModules } from './storeWrites'

/** A shape this many times slower than 9:16 fails (see slower() below). */
const MAX_SLOWER = 1.5
/** The hard limit for one 2 s export. A healthy one takes a few seconds. */
const EXPORT_LIMIT_MS = 45_000
const CLIP_S = 2
const FPS = 30
const TITLES = 6
const MAIN_JS = path.join('out', 'main', 'main.js')
const RENDERER_URL = 'http://localhost:5178'

const STORE = '/src/state/store.ts'
const TYPES = '/src/engine/types.ts'

/** What the clips are made of. A change here makes a new folder, so a stale clip is never reused. */
const RECIPE = {
  hdr: [
    ['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${FPS}:d=${CLIP_S},noise=alls=3:allf=t`],
    ['-f', 'lavfi', '-i', `sine=f=330:sample_rate=48000:d=${CLIP_S}`],
    ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10'],
    ['-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error'],
    ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1'],
    ['-c:a', 'aac', '-ac', '2', '-shortest'],
  ].flat(),
  sdr: [
    ['-f', 'lavfi', '-i', `testsrc2=s=1080x1920:r=${FPS}:d=${CLIP_S},noise=alls=3:allf=t`],
    ['-f', 'lavfi', '-i', `sine=f=440:sample_rate=48000:d=${CLIP_S}`],
    ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest'],
  ].flat(),
}

/** Run ffmpeg and fail with its own words when it does not succeed. */
async function ffmpegOk(args: string[]): Promise<void> {
  const r = await runFfmpeg(['-y', '-loglevel', 'error', ...args])
  if (r.code !== 0) throw new Error(`ffmpeg ${args.join(' ')} exited ${r.code}: ${r.err.slice(-600)}`)
}

/**
 * An iPhone style clip (HEVC Main10, HLG, shot sideways so it carries a 90 degree display rotation,
 * AAC sound) and a plain SDR one, made once per recipe.
 */
async function fixtures(): Promise<{ hdr: string; sdr: string }> {
  const hash = createHash('sha256').update(JSON.stringify(RECIPE)).digest('hex').slice(0, 12)
  const dir = path.join(os.tmpdir(), 'olp-export-shapes', hash)
  const hdr = path.join(dir, 'IMG_HDR.MOV')
  const sdr = path.join(dir, 'IMG_SDR.mp4')
  if (fs.existsSync(hdr) && fs.existsSync(sdr)) return { hdr, sdr }
  fs.mkdirSync(dir, { recursive: true })
  const land = path.join(dir, 'land.mov')
  await ffmpegOk([...RECIPE.hdr, land])
  // A phone records the sensor's way up and says how to turn it. -c copy keeps every bit of the HEVC.
  await ffmpegOk(['-display_rotation:v:0', '90', '-i', land, '-c', 'copy', hdr + '.part.mov'])
  fs.renameSync(hdr + '.part.mov', hdr)
  await ffmpegOk([...RECIPE.sdr, sdr + '.part.mp4'])
  fs.renameSync(sdr + '.part.mp4', sdr)
  return { hdr, sdr }
}

/** The usage log's export lines, oldest first. */
interface ExportLine {
  t: number
  d: { w: number; h: number; outcome?: string; fpsMade?: number }
}
function exportLines(userData: string): ExportLine[] {
  const dir = path.join(userData, 'Usage log')
  if (!fs.existsSync(dir)) return []
  const lines: ExportLine[] = []
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('"k":"export"')) continue
      try {
        lines.push(JSON.parse(line) as ExportLine)
      } catch {
        // A half written last line: the poll below reads again.
      }
    }
  }
  return lines.sort((a, b) => a.t - b.t)
}

/** Keep every window of the app off his screen and out of his way, without hiding it from the GPU. */
async function keepOffScreen(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: eApp, BrowserWindow }) => {
    const quiet = (w: Electron.BrowserWindow): void => {
      w.setOpacity(0)
      w.setSkipTaskbar(true)
    }
    eApp.on('browser-window-created', (_e, w) => quiet(w))
    for (const w of BrowserWindow.getAllWindows()) quiet(w)
    const proto = BrowserWindow.prototype as unknown as Record<string, unknown>
    // show() would take the focus from whatever he is doing; showInactive() paints without it.
    proto.show = function (this: Electron.BrowserWindow) {
      quiet(this)
      this.showInactive()
    }
    proto.focus = function () {}
    proto.maximize = function () {}
  })
}

async function editorWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const win = app.windows().find((w) => /^http:\/\/localhost:5178\/?(index\.html)?$/.test(w.url()))
    if (win) return win
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the editor window never opened')
}

/**
 * Export once and wait for how it ends. Returns the dialog's last words.
 *
 * The buttons are pressed with a dispatched click: a window kept at opacity 0 paints its animation
 * frames slowly, and Playwright's "is it still moving" wait on a plain click cost about 4 s an export.
 */
async function exportOnce(win: Page): Promise<{ text: string; ms: number }> {
  await win.getByTestId('export-open').dispatchEvent('click')
  // On the desktop Export asks which preset first; "Just this once" is the plain save dialog.
  await win.getByTestId('export-once').dispatchEvent('click')
  const t0 = Date.now()
  let text = ''
  while (Date.now() - t0 < EXPORT_LIMIT_MS) {
    text = (await win.getByTestId('export-dialog').innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (/where you chose|to your downloads|stopped|failed|could not|try again/i.test(text)) break
    await win.waitForTimeout(250)
  }
  return { text, ms: Date.now() - t0 }
}

test('every frame shape exports a phone HDR clip, ends, and keeps pace with 9:16', async () => {
  test.setTimeout(180_000)
  if (!runsWithFfmpeg()) test.skip(true, 'needs the bundled ffmpeg')
  if (!fs.existsSync(MAIN_JS)) {
    if (process.env.OLP_GATE) throw new Error(`${MAIN_JS} is missing: the gate builds it before this step`)
    test.skip(true, `needs a build at ${MAIN_JS} (npx electron-vite build)`)
  }

  const clips = await fixtures()
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-export-shapes-run-'))
  const userData = path.join(run, 'profile')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: RENDERER_URL },
  })
  try {
    await keepOffScreen(app)
    const mainPid = await app.evaluate(() => process.pid)
    try {
      os.setPriority(mainPid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Best effort: the ratio is still fair, only louder on the machine.
    }
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __shapeOut: string }
      g.__shapeOut = ''
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: g.__shapeOut })) as typeof dialog.showSaveDialog
    })

    const win = await editorWindow(app)
    await expect(win.getByTestId('export-open')).toBeVisible({ timeout: 60_000 })

    await win.getByTestId('media-file-input').setInputFiles([clips.hdr, clips.sdr])
    await expect(win.getByTestId('asset-card')).toHaveCount(2, { timeout: 60_000 })
    await win.getByTestId('asset-card').filter({ hasText: 'IMG_HDR' }).dblclick()
    await expect(win.locator('[data-clip-kind="video"]')).toHaveCount(1, { timeout: 15_000 })

    // Six caption style titles over the whole clip, each with an outline and a shadow, the way his
    // captions are made. Each is its own track, so all six are on screen in every frame.
    await parkModules(win, [STORE, TYPES])
    const plan = await win.evaluate(
      ({ STORE, TYPES, TITLES }) => {
        const mods = (window as unknown as { __e2eMods: Record<string, Record<string, (...a: unknown[]) => unknown>> }).__e2eMods
        const store = mods[STORE] as unknown as typeof import('../src/state/store')
        const types = mods[TYPES] as unknown as typeof import('../src/engine/types')
        const project = store.useStore.getState().project
        const hdrId = Object.values(project.assets).find((a) => a.name.startsWith('IMG_HDR'))?.id
        const sdrId = Object.values(project.assets).find((a) => a.name.startsWith('IMG_SDR'))?.id
        store.updateActiveSequence('e2e captions', (s) => {
          const video = s.tracks.find((tr) => tr.kind === 'video')!
          const titles = Array.from({ length: TITLES }, (_, i) => {
            const def = {
              ...types.defaultTitleDef(`CAPTION ${i}`),
              vAlign: (i % 2 ? 'top' : 'bottom') as 'top' | 'bottom',
              offsetYPx: i * 120,
              outline: { color: '#000000', widthPx: 12 },
              shadow: { color: 'rgba(0,0,0,0.6)', blurPx: 12, dx: 0, dy: 4 },
            }
            return { ...video, id: types.newId(), name: `Caption ${i}`, clips: [types.newTitleClip(def, 0, s.durationS)] }
          })
          return { ...s, tracks: [...titles, ...s.tracks] }
        })
        const seq = types.activeSequence(store.useStore.getState().project)
        return { hdrId, sdrId, durationS: seq.durationS, names: Object.values(project.assets).map((a) => a.name).join(', ') }
      },
      { STORE, TYPES, TITLES },
    )
    expect(plan.hdrId, `the HDR clip imported (assets: ${plan.names})`).toBeTruthy()
    expect(plan.sdrId, `the SDR clip imported (assets: ${plan.names})`).toBeTruthy()
    const frames = Math.max(1, Math.ceil(plan.durationS * FPS))
    expect(Math.abs(frames - CLIP_S * FPS), `the timeline is ${plan.durationS} s`).toBeLessThanOrEqual(2)

    const runs = [
      ...FORMATS.map((f) => ({ name: `${f.key} HDR`, key: f.key, w: f.w, h: f.h, sdr: false })),
      { name: '9:16 SDR', key: '9:16', w: 1080, h: 1920, sdr: true },
    ]
    const made: { name: string; w: number; h: number; file: string; text: string; ms: number }[] = []
    for (const r of runs) {
      if (r.sdr) {
        await win.evaluate(
          ({ STORE, hdrId, sdrId }) => {
            const mods = (window as unknown as { __e2eMods: Record<string, unknown> }).__e2eMods
            const store = mods[STORE] as typeof import('../src/state/store')
            store.updateActiveSequence('e2e swap to SDR', (s) => ({
              ...s,
              tracks: s.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.assetId === hdrId ? { ...c, assetId: sdrId } : c)) })),
            }))
          },
          { STORE, hdrId: plan.hdrId!, sdrId: plan.sdrId! },
        )
      }
      await win.getByTestId('format-select').selectOption(r.key)
      const file = path.join(run, `${r.name.replace(/[^a-z0-9]+/gi, '-')}.mp4`)
      await app.evaluate((_e, p) => ((globalThis as unknown as { __shapeOut: string }).__shapeOut = p), file)
      const end = await exportOnce(win)
      made.push({ ...r, file, ...end })
      expect(end.text, `${r.name}: the export ended as done within ${EXPORT_LIMIT_MS / 1000} s`).toMatch(/where you chose|to your downloads/)
      await win.getByRole('button', { name: 'Done' }).dispatchEvent('click')
      await expect(win.getByTestId('export-dialog')).toHaveCount(0, { timeout: 5000 })
    }

    // The files: the shape asked for, every frame, and sound. One ffmpeg read each: its report of
    // the input names the size and the streams, and the copy through counts the frames.
    for (const m of made) {
      const read = await runFfmpeg(['-i', m.file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'])
      const size = /Video: .*?, (\d{2,5})x(\d{2,5})[ ,[]/.exec(read.err)
      expect(size && { w: Number(size[1]), h: Number(size[2]) }, `${m.name}: size`).toEqual({ w: m.w, h: m.h })
      const counted = [...read.err.matchAll(/frame=\s*(\d+)/g)].pop()
      expect(Number(counted?.[1]), `${m.name}: frames`).toBe(frames)
      expect(read.err, `${m.name}: an audio stream`).toMatch(/Stream #0:\d+.*: Audio: aac/)
    }

    // The usage log holds the app's own speed for each run. It writes every few seconds; the last
    // write as the app closes is not awaited, so wait for the lines here rather than trust the close.
    const doneLines = () => exportLines(userData).filter((l) => l.d.outcome === 'done')
    await expect
      .poll(() => doneLines().map((l) => `${l.d.w}x${l.d.h}`), { message: 'one done line per export', timeout: 15_000 })
      .toEqual(made.map((m) => `${m.w}x${m.h}`))
    await app.close()
    const done = doneLines()
    // Slowness against 9:16: how much longer a frame takes, less the share that is only more pixels.
    // A shape with FEWER pixels is never credited for them: every shape decodes and tone maps the same
    // phone frame first, so 1:1 makes about as many frames a second as 9:16, not twice as many.
    const refPx = 1080 * 1920
    const speeds = done.map((l, i) => ({ name: made[i].name, ms: made[i].ms, fps: l.d.fpsMade ?? 0, px: l.d.w * l.d.h }))
    const ref = speeds.find((p) => p.name === '9:16 HDR')!
    const slower = (p: { fps: number; px: number }): number => ref.fps / p.fps / Math.max(1, p.px / refPx)
    const report = speeds.map((p) => `${p.name} ${p.fps} fps in ${(p.ms / 1000).toFixed(1)} s, ${slower(p).toFixed(2)}x slower than 9:16`)
    console.log('export shapes:\n  ' + report.join('\n  '))
    for (const p of speeds) {
      expect(p.fps, `${p.name}: the app reported its speed`).toBeGreaterThan(0)
      expect(slower(p), `${p.name} against 9:16\n  ${report.join('\n  ')}`).toBeLessThanOrEqual(MAX_SLOWER)
    }
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(run, { recursive: true, force: true, maxRetries: 3 })
  }
})
