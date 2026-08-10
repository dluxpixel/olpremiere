// A CROSS DISSOLVE MUST SHOW BOTH CLIPS, AND NEITHER OF THEM ANYWHERE ELSE.
//
// His report, 2026-08-10: a one minute source cut down to keep 30s..40s still
// "shows flashes in the cross dissolve of the first few seconds of this clip,
// which I've already edited out".
//
// IT IS NOT THE RESOLVER. resolve.ts maps sequence time to source time
// correctly (`clip.inS + localT * rate`) and the frame cache is exact by frame
// index. It is the texture ladder in preview.ts: THREE of its rungs hand the
// compositor the pooled <video> element without ever checking which frame that
// element is really showing. Measured here on 2026-08-10, one 1s dissolve
// served the outgoing side a picture 0.8s away from the frame asked for, four
// times, and nothing in the code looked.
//
// WHY A RAZORED SOURCE IS THE BAD CASE, AND IT IS HIS NORMAL CASE. One take cut
// into pieces means both sides of the dissolve are the SAME asset, and an asset
// has ONE pooled element. The incoming side drives it (preview.ts says so), so
// the outgoing side is handed that same element, parked wherever the incoming
// side put it. The outgoing clip then shows the INCOMING clip's part of the
// source, and when the element is cold it is parked at 0, which is the head of
// the file: the footage he trimmed off.
//
// THE FIXTURE MAKES IT PROVABLE IN PIXELS RATHER THAN ARGUED. timecode-60s.mp4
// is a different flat colour every ten seconds, with the timecode burned in:
//   0..10 RED   10..20 grey  20..30 GREEN  30..40 BLUE  40..50 olive  50..60 purple
// A keeps 20..22, so A is GREEN. B keeps 30..40, so B is BLUE. A correct
// dissolve is green fading into blue. Red can only be seconds 0..10, the part
// he trimmed off. No green at all means the outgoing clip was never really on
// screen and the "dissolve" was blue into blue.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { shrinkSequence } from './exportHelpers'

const FIXTURE = path.join('e2e', '.fixtures', 'timecode-60s.mp4')

/**
 * Sequence times. A keeps the green block, B keeps the blue one.
 *
 * A TWO SECOND dissolve, not one, and the sequence is shrunk to 640x360 before
 * playing. Both are about the INSTRUMENT, not the defect. Reading one pixel
 * costs a full canvas snapshot, so at 1080p on a loaded machine the sampler
 * managed FOUR reads across a one second window and the spec failed the ship
 * gate on its own sample count while every quality assertion passed. A cheap
 * readback and a longer window make the measurement survive a busy machine
 * without loosening a single thing it actually checks.
 */
const A_IN_S = 20
const A_OUT_SRC_S = 24
const A_OUT_S = 4
const B_IN_S = 30
const B_OUT_S = 40
const DISSOLVE_S = 2

/** Sample away from centre: the burned-in timecode would swamp the channels. */
const SAMPLE_X = 0.15
const SAMPLE_Y = 0.15

/**
 * Red that can only be the trimmed-off head. Green and blue plates carry none,
 * and the h264 round trip of a flat plate lands within a few counts of zero.
 */
const RED_FLOOR = 60

interface Sample {
  tS: number
  r: number
  g: number
  b: number
}

/**
 * Synthesize the fixture once per machine. _verify/ is gitignored, so a spec
 * that reached into it would pass here and fail on a fresh clone, and this
 * suite is the first step of `npm run patch`. Same contract as global-setup.ts:
 * no binary fixtures in the repo.
 */
test.beforeAll(() => {
  if (fs.existsSync(FIXTURE)) return
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
  const block = (from: number, to: number, hex: string): string =>
    `drawbox=x=0:y=0:w=1920:h=1080:color=0x${hex}:t=fill:enable='between(t,${from},${to})'`
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=60',
      '-vf',
      [
        block(0, 10, 'FF0000'),
        block(10, 20, '808080'),
        block(20, 30, '00A000'),
        block(30, 40, '0000FF'),
        block(40, 50, '808000'),
        block(50, 60, '800080'),
        "drawtext=text='%{pts\\:hms}':fontsize=120:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" +
          ':box=1:boxcolor=black@0.6:boxborderw=18',
      ].join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      // Sparse keyframes, the way real camera and gameplay footage is written.
      // A dense GOP makes every seek instant and hides the whole defect.
      '-g', '240', '-keyint_min', '240', '-sc_threshold', '0',
      FIXTURE,
    ],
    { stdio: 'inherit' },
  )
})

/** Read one pixel of the program monitor. preserveDrawingBuffer is on (preview.ts). */
async function previewPixel(page: Page): Promise<[number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = 4
      scratch.height = 4
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, Math.floor(c.width * fx), Math.floor(c.height * fy), 4, 4, 0, 0, 4, 4)
      const d = ctx.getImageData(1, 1, 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { fx: SAMPLE_X, fy: SAMPLE_Y },
  )
}

async function setPlayhead(page: Page, tS: number): Promise<void> {
  await page.evaluate(async (t) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
    }
    useStore.getState().setUI({ playheadS: t })
  }, tS)
}

/**
 * His edit: ONE source razored into two pieces, keeping 20..22 and 30..40, with
 * a cross dissolve at the second piece's head. Both clips are made by the app's
 * own import path and then re-timed, so their shape is whatever the app makes.
 */
async function buildHisEdit(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toHaveCount(1, { timeout: 60_000 })

  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // The second piece is a CLONE of the first, which is what the blade leaves
  // behind: two clips, one asset, one pooled <video> element between them. The
  // app refuses to insert the same asset twice, so cloning is also the only way
  // to get there from here.
  await page.evaluate(
    async ({ aIn, aOutSrc, aOut, bIn, bOut }) => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { dispatch: (l: string, f: (p: unknown) => unknown) => void } }
      }
      // Immutable all the way down: the store compares identities to decide
      // what re-renders, so an in-place mutation lands in the state and never
      // reaches the screen.
      useStore.getState().dispatch('test: his razored edit', (p) => {
        const proj = p as { activeSequenceId: string; sequences: Record<string, unknown> }
        const seq = proj.sequences[proj.activeSequenceId] as {
          tracks: { kind: string; clips: Record<string, unknown>[] }[]
        }
        return {
          ...proj,
          sequences: {
            ...proj.sequences,
            [proj.activeSequenceId]: {
              ...seq,
              tracks: seq.tracks.map((track) => {
                if (track.kind !== 'video' || track.clips.length !== 1) return track
                const src = track.clips[0]
                const a = { ...src, startS: 0, inS: aIn, outS: aOutSrc }
                const b = {
                  ...structuredClone(src),
                  id: crypto.randomUUID(),
                  startS: aOut,
                  inS: bIn,
                  outS: bOut,
                }
                return { ...track, clips: [a, b] }
              }),
            },
          },
        }
      })
    },
    { aIn: A_IN_S, aOutSrc: A_OUT_SRC_S, aOut: A_OUT_S, bIn: B_IN_S, bOut: B_OUT_S },
  )
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

  const clipBId = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const track = seq.tracks.find((t) => t.kind === 'video' && t.clips.length === 2)!
    return track.clips[1].id
  })

  await page.evaluate(
    async ({ id, d }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const { setClipTransition } = (await import(/* @vite-ignore */ editsMod)) as {
        setClipTransition: (id: string, edge: 'in' | 'out', kind: string, durationS?: number) => void
      }
      setClipTransition(id, 'in', 'crossDissolve', d)
    },
    { id: clipBId, d: DISSOLVE_S },
  )

  // A small program raster, so one pixel read costs almost nothing. The colours
  // under test are flat plates, so nothing this spec measures depends on the
  // raster being big, and the source stays 1920x1080 either way.
  await shrinkSequence(page, 640, 360)
}

/** Play from `startS` for `forMs`, sampling the program monitor every frame. */
async function playAndSample(page: Page, startS: number, forMs: number): Promise<Sample[]> {
  await setPlayhead(page, startS)
  // The store is imported ONCE, outside the loop. An await inside the rAF
  // callback costs a microtask turn per frame, and the sampler then managed
  // four reads across a whole window: too coarse to see a few-frame flash.
  await page.evaluate(
    async ({ x, y }) => {
      const w = window as unknown as { __flashSamples?: unknown[]; __stopSampling?: () => void }
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { ui: { playheadS: number } } }
      }
      const out: { tS: number; r: number; g: number; b: number }[] = []
      w.__flashSamples = out
      const scratch = document.createElement('canvas')
      scratch.width = 4
      scratch.height = 4
      const ctx = scratch.getContext('2d')!
      let raf = 0
      const tick = (): void => {
        const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement | null
        if (c && c.width > 0) {
          ctx.drawImage(c, Math.floor(c.width * x), Math.floor(c.height * y), 4, 4, 0, 0, 4, 4)
          const d = ctx.getImageData(1, 1, 1, 1).data
          out.push({ tS: useStore.getState().ui.playheadS, r: d[0], g: d[1], b: d[2] })
        }
        raf = requestAnimationFrame(tick)
      }
      w.__stopSampling = () => cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    },
    { x: SAMPLE_X, y: SAMPLE_Y },
  )

  await page.getByTestId('play-toggle').click()
  await page.waitForTimeout(forMs)
  await page.evaluate(() => (window as unknown as { __stopSampling: () => void }).__stopSampling())
  const samples = (await page.evaluate(
    () => (window as unknown as { __flashSamples: Sample[] }).__flashSamples,
  )) as Sample[]
  await page.getByTestId('play-toggle').click()
  return samples
}

function report(samples: Sample[], label: string): Sample[] {
  const inWindow = samples.filter((s) => s.tS >= A_OUT_S && s.tS <= A_OUT_S + DISSOLVE_S)
  const green = inWindow.filter((s) => s.g > 60)
  const red = inWindow.filter((s) => s.r > RED_FLOOR)
  console.log(
    `[${label}] ${samples.length} samples, ${inWindow.length} in the dissolve, ` +
      `${green.length} carrying the outgoing clip, ${red.length} carrying trimmed-off footage\n` +
      inWindow.map((s) => `    t=${s.tS.toFixed(2)} rgb(${s.r},${s.g},${s.b})`).join('\n'),
  )
  return inWindow
}

test('a cross dissolve on a razored source shows the outgoing clip, not another part of it', async ({
  page,
}) => {
  await buildHisEdit(page)
  await setPlayhead(page, 1)
  await expect.poll(async () => (await previewPixel(page))[1], { timeout: 20_000 }).toBeGreaterThan(60)

  const samples = await playAndSample(page, A_OUT_S - 1.5, 6000)
  const inWindow = report(samples, 'razored source, played into the cut')
  expect(inWindow.length, 'the dissolve was actually played through').toBeGreaterThan(8)

  // B really arrives, so nothing below can pass by drawing nothing at all.
  const arrived = samples.filter((s) => s.tS > A_OUT_S + DISSOLVE_S && s.b > 120 && s.g < 60)
  expect(arrived.length, 'clip B is on screen after the dissolve').toBeGreaterThan(2)

  // NO FOOTAGE FROM OUTSIDE THE TRIM. His actual complaint.
  const flashes = inWindow.filter((s) => s.r > RED_FLOOR)
  const worstRed = flashes.reduce((m, s) => (s.r > m ? s.r : m), 0)
  expect(
    flashes.length,
    `frames showing the trimmed-off head during the dissolve (worst red ${worstRed}, ` +
      `a green-to-blue dissolve can only be 0): ${JSON.stringify(flashes.slice(0, 6))}`,
  ).toBe(0)

  // AND THE OUTGOING CLIP IS REALLY THERE. A dissolve that never shows clip A
  // is clip B dissolving into itself, which is the same defect wearing a colour
  // that happens not to be red.
  const carryingA = inWindow.filter((s) => s.g > 60)
  expect(
    carryingA.length,
    `frames carrying the outgoing clip's own footage (green): the dissolve must show clip A, ` +
      `not another part of the same source`,
  ).toBeGreaterThan(2)

  // NOT BLACK. Refusing to composite a wrong picture is only half a fix: a
  // cross dissolve weights from*(1-p) + to*p, so a side with no texture fades
  // the other clip toward black instead of showing it. The first cut of this
  // fix did exactly that for the back half of the window, and the pixels are
  // the only reason anyone knew.
  const black = inWindow.filter((s) => s.r + s.g + s.b < 30)
  expect(
    black.length,
    `black frames inside the dissolve: a side that cannot prove its picture must ` +
      `hold its last good frame, not go dark: ${JSON.stringify(black.slice(0, 6))}`,
  ).toBe(0)

  // AND IT REALLY CROSSES. At least one frame carries both clips at once, which
  // is the difference between a dissolve and a cut with extra steps.
  const blended = inWindow.filter((s) => s.g > 30 && s.b > 30)
  expect(
    blended.length,
    `frames carrying BOTH clips at once: a cross dissolve has to actually mix them, ` +
      `and holding one clip flat then snapping to the other is what this looked like when broken`,
  ).toBeGreaterThan(0)
})
