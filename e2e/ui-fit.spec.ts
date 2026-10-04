import { expect, test, type Page } from '@playwright/test'

// THE SECOND WALK-THROUGH (2026-10-03). His ask was that nothing overlaps and everything works,
// and the first pass left four things it had seen and not fixed, plus one that arrived with the
// Captions tab. Each test below is the proof for one of them, at the sizes that broke it:
// 1600x900, 1280x720 and the app's own minimum window, 1024x680, with the side columns at their
// default and at their narrowest (src/useLayoutSizes.ts: left 200, right 340).

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** Start the app at a window size with the side columns set, one clip on the timeline. */
async function open(page: Page, w: number, h: number, left: number, right: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h })
  await page.addInitScript((sizes) => localStorage.setItem('olpremiere.layout.v2', JSON.stringify(sizes)), {
    left,
    right,
    bottom: 260,
  })
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

const SIZES = [
  { name: '1600x900, default columns', w: 1600, h: 900, left: 280, right: 450 },
  { name: '1280x720, default columns', w: 1280, h: 720, left: 280, right: 450 },
  { name: '1280x720, narrowest columns', w: 1280, h: 720, left: 200, right: 340 },
  { name: '1024x680 (the minimum window), default columns', w: 1024, h: 680, left: 280, right: 450 },
  { name: '1024x680 (the minimum window), narrowest columns', w: 1024, h: 680, left: 200, right: 340 },
]

for (const s of SIZES) {
  test.describe(s.name, () => {
    test('the five left tabs are all whole, on the panel, and do not scroll sideways', async ({ page }) => {
      await open(page, s.w, s.h, s.left, s.right)
      const strip = page.getByTestId('panel-left').getByRole('tablist')
      const stripBox = (await strip.boundingBox())!
      expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const names = ['Media', 'Effects', 'Library', 'Words', 'Captions']
      for (const name of names) {
        const tab = strip.getByRole('tab', { name, exact: true })
        const box = (await tab.boundingBox())!
        // On the panel, with the strip's own padding to spare on both sides.
        expect(box.x, `${name} starts inside the panel`).toBeGreaterThanOrEqual(stripBox.x + 4)
        expect(box.x + box.width, `${name} ends inside the panel`).toBeLessThanOrEqual(stripBox.x + stripBox.width - 4)
        // And its word is not cut inside the tab.
        expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} is not truncated`).toBe(true)
      }
    })
  })
}

// ---------------------------------------------------------------------------------------------
// The Monitor's transport bar. At 1280x720 it squeezed the aspect picker and the camera out of
// sight and left Preview as a bare arrow; at the minimum window there are 292px for 12 controls.
// Every control has to be on the bar, whole, and clear of the next one, at every size. And on
// 2026-10-04 he asked for: the two selects no wider than their short label, Safe margins back on the
// bar, a Loop button that says what it is, and the way out of full screen always in the same corner.

const BAR_CONTROLS: Array<{ name: string; locate: (p: Page) => ReturnType<Page['locator']> }> = [
  { name: 'Go to start', locate: (p) => p.getByRole('button', { name: 'Go to start' }) },
  { name: 'Step back', locate: (p) => p.getByRole('button', { name: 'Step back 1 frame' }) },
  { name: 'Play', locate: (p) => p.getByTestId('play-toggle') },
  { name: 'Step forward', locate: (p) => p.getByRole('button', { name: 'Step forward 1 frame' }) },
  { name: 'Go to end', locate: (p) => p.getByRole('button', { name: 'Go to end' }) },
  { name: 'Screenshot', locate: (p) => p.getByTestId('screenshot-button') },
  { name: 'Aspect picker', locate: (p) => p.getByTestId('format-select') },
  { name: 'Frame settings', locate: (p) => p.getByTestId('frame-settings-button') },
  { name: 'Safe margins', locate: (p) => p.getByTestId('safe-margins-bar-toggle') },
  { name: 'Loop', locate: (p) => p.getByTestId('loop-toggle') },
  { name: 'Preview quality', locate: (p) => p.getByTestId('preview-quality') },
  { name: 'Full screen', locate: (p) => p.getByTestId('fullscreen-toggle') },
]

for (const s of SIZES) {
  test(`the transport bar fits every control at ${s.name}`, async ({ page }) => {
    await open(page, s.w, s.h, s.left, s.right)
    const bar = (await page.getByTestId('transport-bar').boundingBox())!
    const boxes: Array<{ name: string; x: number; y: number; width: number; height: number }> = []
    for (const c of BAR_CONTROLS) {
      const el = c.locate(page)
      await expect(el, `${c.name} is on the bar`).toBeVisible()
      boxes.push({ name: c.name, ...(await el.boundingBox())! })
    }

    for (const b of boxes) {
      // On the bar, all of it: nothing pushed past an edge or clipped by one.
      expect(b.x, `${b.name} inside the bar, left`).toBeGreaterThanOrEqual(bar.x)
      expect(b.x + b.width, `${b.name} inside the bar, right`).toBeLessThanOrEqual(bar.x + bar.width)
      expect(b.y, `${b.name} inside the bar, top`).toBeGreaterThanOrEqual(bar.y)
      expect(b.y + b.height, `${b.name} inside the bar, bottom`).toBeLessThanOrEqual(bar.y + bar.height + 0.5)
    }
    // Clear of each other.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        expect(w > 1 && h > 1, `${a.name} and ${b.name} overlap`).toBe(false)
      }
    }

    // The two selects say the short name and are no wider than it needs: "16:9" and "Full", a
    // box of about 50px each. Before, they were 69 and 82 wide with blank space inside.
    const face = (id: string) =>
      page.getByTestId(id).evaluate((el) => ({
        text: (el.querySelector('selectedcontent') as HTMLElement | null)?.innerText.trim() ?? '',
        width: el.getBoundingClientRect().width,
      }))
    const aspect = await face('format-select')
    expect(aspect.text).toBe('16:9')
    expect(aspect.width).toBeGreaterThanOrEqual(36)
    expect(aspect.width).toBeLessThanOrEqual(62)
    const preview = await face('preview-quality')
    expect(preview.text).toBe('Full')
    expect(preview.width).toBeGreaterThanOrEqual(36)
    expect(preview.width).toBeLessThanOrEqual(62)

    // The time is never cut. (Where the total length has no room it is dropped whole.)
    const time = page.getByTestId('timecode')
    expect(await time.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(true)

    // Play is on the centre of the bar wherever the bar has the room to put it there.
    const tier = await page.getByTestId('transport-bar').getAttribute('data-tier')
    if (tier !== 'compact') {
      const play = boxes.find((b) => b.name === 'Play')!
      expect(Math.abs(play.x + play.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(2)
    }

    // The way out of full screen is pinned to the bar's bottom right corner: the same 8px in from
    // the right at every size, and level with the last row of controls.
    const full = boxes.find((b) => b.name === 'Full screen')!
    expect(Math.round(bar.x + bar.width - (full.x + full.width))).toBe(8)
    expect(Math.round(bar.y + bar.height - (full.y + full.height))).toBe(8)
  })
}

test('the aspect list and the Preview list open with the full names', async ({ page }) => {
  await open(page, 1280, 720, 280, 450)
  for (const [id, closed, listed] of [
    ['format-select', '16:9', ['16:9 Wide', '9:16 Shorts', '1:1 Square']],
    ['preview-quality', 'Full', ['Full quality', 'Half (faster)', 'Quarter (fastest)']],
  ] as const) {
    const select = page.getByTestId(id)
    // Closed: the short name only.
    expect(await select.evaluate((el) => (el.querySelector('selectedcontent') as HTMLElement).innerText.trim())).toBe(closed)
    // Open: every option reads in full, and none of them reads as the short and long run together.
    const names = await select.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => (o.querySelector('.opt-long') as HTMLElement).innerText.trim()))
    expect(names).toEqual([...listed])
    await select.evaluate((el) => (el as HTMLSelectElement).showPicker())
    for (const name of listed) await expect(page.getByRole('option', { name, exact: true })).toBeVisible()
    // Light dismiss: a click anywhere else shuts the list.
    await page.mouse.click(4, 4)
    await expect(page.getByRole('option', { name: listed[0], exact: true })).toBeHidden()
  }
  // And it is still a real select: choosing 9:16 changes the sequence, the face follows.
  await page.getByTestId('format-select').selectOption('9:16')
  await expect(page.getByTestId('format-select')).toHaveValue('9:16')
  expect(await page.getByTestId('format-select').evaluate((el) => (el.querySelector('selectedcontent') as HTMLElement).innerText.trim())).toBe('9:16')
  await page.getByTestId('preview-quality').selectOption('0.5')
  expect(await page.getByTestId('preview-quality').evaluate((el) => (el.querySelector('selectedcontent') as HTMLElement).innerText.trim())).toBe('Half')
})

test('Safe margins is on the bar, one switch with the one in the Frame menu', async ({ page }) => {
  await open(page, 1280, 720, 280, 450)
  const toggle = page.getByTestId('safe-margins-bar-toggle')
  await expect(page.getByTestId('safe-margins')).toHaveCount(0)
  await expect(toggle).not.toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(page.getByTestId('safe-margins')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  // The same switch, in the Frame menu where it was put on 2026-09-14.
  await page.getByTestId('frame-settings-button').click()
  await expect(page.getByTestId('safe-margins-toggle')).toBeChecked()
  await page.getByTestId('safe-margins-toggle').setChecked(false)
  await expect(page.getByTestId('safe-margins')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(toggle).not.toHaveAttribute('aria-pressed', 'true')
})

test('Loop says what it is, lights while it is on, and the tooltip says what it does', async ({ page }) => {
  await open(page, 1280, 720, 280, 450)
  const loop = page.getByTestId('loop-toggle')
  await expect(loop).toContainText('Loop')
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
  await loop.hover()
  const tip = page.locator('[role="tooltip"]:visible')
  await expect(tip).toContainText('repeat the In to Out range, or the whole edit')
  await loop.click()
  await expect(loop).toHaveAttribute('aria-pressed', 'true')
  await expect(tip).toContainText('Loop is on')
  // Lit, not just labelled: the ember fill the app uses for a live state. (Polled: the fill fades in.)
  const fill = (el: ReturnType<Page['locator']>) => el.evaluate((node) => getComputedStyle(node).backgroundColor)
  const resting = await fill(page.getByTestId('frame-settings-button'))
  await expect.poll(() => fill(loop)).not.toBe(resting)
  await loop.click()
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
})

test.describe('Full screen', () => {
  const inFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null)

  for (const s of [SIZES[0], SIZES[1], SIZES[3]]) {
    test(`the way out sits in the corner it went in from, and the picture is left clean, at ${s.name}`, async ({ page }) => {
      await open(page, s.w, s.h, s.left, s.right)
      await page.locator('[data-clip-kind="video"]').first().click()
      // In the window, with a clip selected, the picture wears its handles.
      await expect(page.getByTestId('transform-gizmo')).toBeVisible()
      await page.getByTestId('safe-margins-bar-toggle').click()
      const toggle = page.getByTestId('fullscreen-toggle')
      const bar = page.getByTestId('transport-bar')
      const corner = async () => {
        const b = (await bar.boundingBox())!
        const t = (await toggle.boundingBox())!
        return { right: Math.round(b.x + b.width - (t.x + t.width)), bottom: Math.round(b.y + b.height - (t.y + t.height)) }
      }
      const before = await corner()

      await toggle.click()
      await expect.poll(() => inFullscreen(page)).toBe('monitor')
      await expect(toggle).toHaveAccessibleName(/Exit full screen/)
      // The same corner of the bar: same distance from the right, same distance from the bottom.
      expect(await corner()).toEqual(before)
      // The bar's corner is the screen's: the button is where a thumb goes, bottom right.
      const t = (await toggle.boundingBox())!
      const vp = page.viewportSize()!
      expect(vp.width - (t.x + t.width)).toBeLessThanOrEqual(10)
      expect(vp.height - (t.y + t.height)).toBeLessThanOrEqual(10)
      // No editing chrome on the picture: no box, no handles, no stray handle at the left edge...
      await expect(page.getByTestId('transform-gizmo')).toHaveCount(0)
      await expect(page.getByTestId('preview-select')).toHaveCount(0)
      // ...but the guides he asked for stay.
      await expect(page.getByTestId('safe-margins')).toBeVisible()

      // And the same button leaves.
      await toggle.click()
      await expect.poll(() => inFullscreen(page)).toBe(null)
      await expect(toggle).toHaveAccessibleName(/Full screen/)
      expect(await corner()).toEqual(before)
      await expect(page.getByTestId('transform-gizmo')).toBeVisible()
    })
  }
})

// ---------------------------------------------------------------------------------------------
// Escape closes a dialog. The Projects dialog and the Recording studio never listened for it.

test.describe('Escape', () => {
  // With a clip on the timeline, as in use: the Export and Record buttons need one.
  test.beforeEach(async ({ page }) => {
    await open(page, 1600, 900, 280, 450)
  })

  test('closes the Projects dialog', async ({ page }) => {
    await page.getByTestId('open-projects').click()
    await expect(page.getByTestId('projects-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
  })

  test('closes the Settings dialog', async ({ page }) => {
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  })

  test('closes the Export dialog and the Paste picture dialog', async ({ page }) => {
    await page.evaluate(async () => {
      const jobMod = '/src/state/exportJob.ts'
      const planMod = '/src/engine/export/exportPlan.ts'
      const typesMod = '/src/engine/types.ts'
      const storeMod = '/src/state/store.ts'
      const { useExportJob } = (await import(/* @vite-ignore */ jobMod)) as { useExportJob: { setState: (s: unknown) => void } }
      const { planExport } = (await import(/* @vite-ignore */ planMod)) as { planExport: (s: unknown) => unknown }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => unknown }
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
      const plan = planExport(activeSequence(useStore.getState().project))
      useExportJob.setState({
        job: { id: 1, projectName: 'Untitled Project', plan, stage: { kind: 'error', message: 'Nothing to export' }, background: true },
        dialogOpen: true,
        alreadyRunning: false,
      })
    })
    await expect(page.getByTestId('export-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('export-dialog')).toHaveCount(0)

    await page.evaluate(async () => {
      const f = '/src/state/picturePaste.ts'
      const m = (await import(/* @vite-ignore */ f)) as { usePastePicture: { setState: (s: unknown) => void } }
      const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
      m.usePastePicture.setState({
        picture: { file: new File([blob], 'p.png', { type: 'image/png' }), url: URL.createObjectURL(blob), atS: 0 },
        phase: 'ask',
        problem: null,
      })
    })
    await expect(page.getByTestId('paste-picture-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('paste-picture-dialog')).toHaveCount(0)
  })

  test('closes an idle Recording studio, and leaves one that is recording or holds a take alone', async ({ page }) => {
    await page.getByTestId('record-voice').click()
    const studio = page.getByTestId('recording-studio')
    await expect(studio).toBeVisible()
    // Recording, for real, on the fake microphone the browser is started with.
    await page.getByTestId('studio-record').click()
    await expect(page.getByTestId('studio-elapsed')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(studio).toBeVisible()
    // Stopped, with the take waiting to be kept or thrown away: Escape must not throw it away.
    await page.getByTestId('studio-record').click()
    await expect(page.getByTestId('studio-keep')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(studio).toBeVisible()
    await expect(page.getByTestId('studio-keep')).toBeVisible()
    // Discarded: nothing to lose, so Escape closes it.
    await page.getByTestId('studio-discard').click()
    await expect(page.getByTestId('studio-keep')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(studio).toHaveCount(0)
  })

  test('closes a name prompt over Settings alone, from the field and from beside it', async ({ page }) => {
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
    const ask = () =>
      page.evaluate(async () => {
        const f = '/src/state/namePrompt.ts'
        const { askForName } = (await import(/* @vite-ignore */ f)) as { askForName: (r: unknown) => Promise<unknown> }
        void askForName({ title: 'Name this track setup', confirmLabel: 'Save', initial: 'Setup 1' })
      })
    // From the field (it has the focus): the prompt goes, Settings stays.
    await ask()
    await expect(page.getByTestId('name-prompt')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('name-prompt')).toHaveCount(0)
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
    // From beside it (focus on the dialog's title, not the field): the same.
    await ask()
    await expect(page.getByTestId('name-prompt')).toBeVisible()
    await page.getByTestId('name-prompt').getByText('Name this track setup').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('name-prompt')).toHaveCount(0)
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
    // Now Settings itself.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  })

  test('closes a menu open over a dialog first, and the dialog on the next press', async ({ page }) => {
    await page.getByTestId('open-projects').click()
    await expect(page.getByTestId('projects-dialog')).toBeVisible()
    await page.evaluate(async () => {
      const f = '/src/state/contextMenu.ts'
      const { useContextMenu } = (await import(/* @vite-ignore */ f)) as {
        useContextMenu: { getState: () => { show: (x: number, y: number, items: unknown[]) => void } }
      }
      useContextMenu.getState().show(200, 200, [{ label: 'One' }, { label: 'Two' }])
    })
    await expect(page.getByTestId('context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('context-menu')).toHaveCount(0)
    await expect(page.getByTestId('projects-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
  })

  test('lets go of a text field in a dialog first, keeping what was typed', async ({ page }) => {
    await page.getByTestId('tab-captions').click()
    await page.getByTestId('captions-paste').click()
    const dialog = page.getByTestId('captions-dialog')
    await expect(dialog).toBeVisible()
    const box = dialog.locator('textarea').first()
    await box.click()
    await box.fill('so it goes')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(box).toHaveValue('so it goes')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Toasts never cover an open menu. The stack sat in the bottom right corner above the right-click
// menu, hid its last rows and took the clicks meant for them.

for (const s of [SIZES[0], SIZES[1], SIZES[3]]) {
  test(`a toast stack steps aside for a menu in its corner, and comes home after, at ${s.name}`, async ({ page }) => {
    await open(page, s.w, s.h, s.left, s.right)
    await page.evaluate(async () => {
      const f = '/src/state/toasts.ts'
      const { useToasts } = (await import(/* @vite-ignore */ f)) as {
        useToasts: { getState: () => { show: (m: string, k?: string, a?: unknown, o?: unknown) => void } }
      }
      const t = useToasts.getState()
      t.show('Opened “Gym reel 12”', 'success', undefined, { durationMs: 60_000 })
      t.show('Could not save this project. Staying here so nothing is lost', 'danger', undefined, { durationMs: 60_000 })
      t.show('Deleted 3 clips', 'info', { label: 'Undo', onClick: () => {} }, { durationMs: 60_000 })
    })
    const stack = page.getByTestId('toast-stack')
    await expect(stack).toBeVisible()
    await expect(stack).toHaveAttribute('data-corner', 'br')

    // A menu in the very corner the toasts are in, with a flyout.
    await page.evaluate(
      async ({ x, y }) => {
        const f = '/src/state/contextMenu.ts'
        const { useContextMenu } = (await import(/* @vite-ignore */ f)) as {
          useContextMenu: { getState: () => { show: (x: number, y: number, items: unknown[]) => void } }
        }
        const rows = Array.from({ length: 8 }, (_, i) => ({ label: `Row ${i + 1}` }))
        useContextMenu.getState().show(x, y, [
          ...rows,
          { label: 'More', submenu: [{ label: 'Inside one' }, { label: 'Inside two' }] },
        ])
      },
      { x: s.w - 240, y: s.h - 330 },
    )
    const menu = page.getByTestId('context-menu')
    await expect(menu).toBeVisible()

    const clear = async () => {
      const t = (await stack.boundingBox())!
      for (const m of await page.getByRole('menu').all()) {
        const b = (await m.boundingBox())!
        const apart = t.x + t.width <= b.x || b.x + b.width <= t.x || t.y + t.height <= b.y || b.y + b.height <= t.y
        expect(apart, 'the toasts and the menu are apart').toBe(true)
      }
    }
    await expect.poll(async () => stack.getAttribute('data-corner')).not.toBe('br')
    await clear()

    // With the flyout out, the menu's edge has moved: still clear.
    await menu.getByRole('menuitem', { name: 'More' }).hover()
    await expect(page.getByRole('menu')).toHaveCount(2)
    await expect.poll(async () => {
      const t = (await stack.boundingBox())!
      for (const m of await page.getByRole('menu').all()) {
        const b = (await m.boundingBox())!
        if (!(t.x + t.width <= b.x || b.x + b.width <= t.x || t.y + t.height <= b.y || b.y + b.height <= t.y)) return false
      }
      return true
    }).toBe(true)

    // The menu goes, the toasts go home.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(stack).toHaveAttribute('data-corner', 'br')
  })
}

// ---------------------------------------------------------------------------------------------
// The Captions tab, all three parts, stays inside its own panel. At 1280x720 its list was painted
// over the timeline's toolbar: the top was a fixed height and the list held 140px, which together
// are more than the column a short window leaves.

const SCRIPT = JSON.stringify([
  { text: 'so', startS: 0.1, endS: 0.3 },
  { text: 'this', startS: 0.35, endS: 0.55 },
  { text: 'is', startS: 0.6, endS: 0.75 },
  { text: 'the', startS: 0.8, endS: 0.9 },
  { text: 'captions', startS: 0.95, endS: 1.3 },
  { text: 'test', startS: 1.35, endS: 1.7 },
  { text: 'with', startS: 1.8, endS: 1.95 },
  { text: 'a', startS: 2.0, endS: 2.1 },
  { text: 'longer', startS: 2.2, endS: 2.5 },
  { text: 'line', startS: 2.55, endS: 2.8 },
])

for (const s of SIZES) {
  test(`the Captions tab stays inside its panel, Style shut and open, at ${s.name}`, async ({ page }) => {
    await open(page, s.w, s.h, s.left, s.right)
    await page.getByTestId('tab-captions').click()
    await page.getByTestId('captions-paste').click()
    await page.getByTestId('captions-dialog').locator('textarea').first().fill(SCRIPT)
    await page.getByTestId('captions-apply').click()
    await expect(page.getByTestId('caption-row').first()).toBeVisible()

    const fold = page.getByTestId('captions-style-fold')
    for (const open of [false, true]) {
      if ((await fold.getAttribute('aria-expanded')) !== String(open)) await fold.click()
      const panel = (await page.getByTestId('panel-left').boundingBox())!
      const list = (await page.getByTestId('captions-list').boundingBox())!
      // The list is wholly in the panel...
      expect(list.y + list.height, `list bottom, style ${open ? 'open' : 'shut'}`).toBeLessThanOrEqual(panel.y + panel.height + 0.5)
      // ...and has room for a few captions, so shrinking never made it useless.
      expect(list.height).toBeGreaterThanOrEqual(90)
      // Nothing of the tab is painted below the panel: the point just under it belongs to the timeline.
      const below = await page.evaluate(
        ({ x0, x1, y }) => {
          const hits: string[] = []
          for (let x = x0; x <= x1; x += 24) {
            const el = document.elementFromPoint(x, y)
            if (el?.closest('[data-testid="captions-tab"]')) hits.push(el.getAttribute('data-testid') ?? el.tagName)
          }
          return hits
        },
        { x0: panel.x + 6, x1: panel.x + panel.width - 6, y: panel.y + panel.height + 6 },
      )
      expect(below, 'tab painted below its panel').toEqual([])
    }
  })
}

// A side column never paints below its own bottom edge, on any tab, at any size. The Captions tab did
// (above); this is the same look at every other tab, and at the Inspector with a clip selected.

for (const s of [SIZES[1], SIZES[3], SIZES[4]]) {
  test(`no side column paints over the timeline, on any tab, at ${s.name}`, async ({ page }) => {
    await open(page, s.w, s.h, s.left, s.right)
    await page.locator('[data-clip-kind="video"]').first().click()
    const paintedBelow = (testId: string) =>
      page.evaluate((id) => {
        const panel = document.querySelector(`[data-testid="${id}"]`)!
        const r = panel.getBoundingClientRect()
        const hits: string[] = []
        for (let x = r.left + 6; x <= r.right - 6; x += 24) {
          const el = document.elementFromPoint(x, r.bottom + 6)
          if (el && panel.contains(el)) hits.push(el.getAttribute('data-testid') ?? el.tagName)
        }
        return hits
      }, testId)
    for (const tab of ['media', 'effects', 'library', 'words', 'captions']) {
      await page.getByTestId(`tab-${tab}`).click()
      expect(await paintedBelow('panel-left'), `${tab} tab painted below the left column`).toEqual([])
    }
    expect(await paintedBelow('panel-right'), 'the Inspector painted below the right column').toEqual([])
  })
}
