// The private usage log, end to end: a few real actions in the real app land as
// events, carrying his words for them and none of his material, the switch in
// Settings turns it off for good, and recording costs the interface nothing.
//
// The web build keeps its log in a small IndexedDB of its own (usageStoreWeb.ts);
// the desktop app writes the same lines to a file. These read the web one back.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

interface UsageEvent {
  t: number
  s: string
  p?: string
  k: string
  a: string
  d?: Record<string, string | number | boolean>
  ms?: number
}

/** Write what is waiting, then read the whole log back out of the browser's own store. */
async function events(page: Page): Promise<UsageEvent[]> {
  return page.evaluate(async () => {
    const logMod = '/src/state/usageLog.ts'
    const webMod = '/src/state/usageStoreWeb.ts'
    const { usage } = (await import(/* @vite-ignore */ logMod)) as { usage: { flush: () => Promise<void> } }
    const { readWebUsage } = (await import(/* @vite-ignore */ webMod)) as {
      readWebUsage: () => Promise<{ day: string; text: string }[]>
    }
    await usage.flush()
    const days = await readWebUsage()
    return days
      .flatMap((d) =>
        d.text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as UsageEvent),
      )
      .sort((a, b) => a.t - b.t)
  })
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

const names = (list: UsageEvent[]): string[] => list.map((e) => `${e.k} ${e.a}`)

test('real actions land as events, and none of them carries his material', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // A shortcut, a click on a button, a dialog, a choice in it, and a key that closes it.
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('m')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId('theme-light').click()
  // A real keystroke on the select, not selectOption: that one fires a change the page cannot tell
  // from a script, and the log (rightly) ignores what the page does to itself.
  await page.getByTestId('settings-quality').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  // The dialog scan runs a moment after the last thing he did.
  await page.waitForTimeout(500)

  const list = await events(page)
  const find = (k: string, a: string) => list.find((e) => e.k === k && e.a === a)

  expect(find('session', 'start'), JSON.stringify(list.slice(0, 6))).toBeTruthy()
  expect(find('session', 'start')?.d).toMatchObject({ shell: 'web' })
  // The import: a count and the kinds of file, not the file.
  expect(find('import', 'Import files')?.d).toMatchObject({ n: 1, exts: 'webm:1' })
  // The shortcut, with what it is for, and the edit it made.
  expect(find('key', 'm')?.d).toEqual({ cmd: 'Add marker at playhead' })
  expect(find('edit', 'Add marker')).toBeTruthy()
  // The buttons, named by their testid, with where they are.
  expect(find('ui', 'settings-open')?.d).toMatchObject({ panel: 'topbar', role: 'button' })
  expect(find('ui', 'theme-light')?.d).toMatchObject({ panel: 'dialog:settings-dialog' })
  // A choice in a select: that it changed, never to what.
  expect(find('ui', 'settings-quality')?.d).toEqual({ panel: 'dialog:settings-dialog', role: 'select' })
  // The dialog opening and closing, and how long it was open.
  expect(list.filter((e) => e.k === 'dialog' && e.a === 'settings-dialog').map((e) => e.d?.op)).toEqual(['open', 'close'])
  expect(
    list.find((e) => e.k === 'dialog' && e.d?.op === 'close')?.ms,
    JSON.stringify(list.filter((e) => e.k === 'dialog' || e.k === 'ui').map((e) => [e.t % 100000, e.k, e.a, e.ms])),
  ).toBeGreaterThan(0)
  // Every line after the project loaded says which project, by id.
  expect(find('key', 'm')?.p).toMatch(/\S/)
  expect(find('session', 'start')?.p).toBeUndefined()
  // Order is the order he did things in.
  const order = names(list)
  expect(order.indexOf('ui settings-open')).toBeLessThan(order.indexOf('dialog settings-dialog'))
  expect(order.indexOf('dialog settings-dialog')).toBeLessThan(order.indexOf('ui theme-light'))

  // Nothing of his: not the file's name, a path, or the project's name.
  const text = JSON.stringify(list)
  expect(text).not.toMatch(/clip\.webm|\.fixtures|e2e[\\/]/)
  const projectName = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: { name: string } } } }
    return useStore.getState().project.name
  })
  expect(text).not.toContain(projectName)
})

test('what he types never reaches the log', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('t')
  const field = page.getByTestId('title-text')
  await expect(field).toBeVisible({ timeout: 10_000 })
  await field.fill('MY SECRET WORDS 4421')
  await field.press('End')
  await field.pressSequentially(' and more private text', { delay: 5 })
  await page.waitForTimeout(300)

  const list = await events(page)
  const text = JSON.stringify(list)
  expect(text).not.toMatch(/SECRET|4421|private text|and more/i)
  // The field he typed in is named, once; the typing is one line with a count, not one per key.
  expect(list.filter((e) => e.k === 'ui' && e.a === 'title-text')).toHaveLength(1)
  const typing = list.filter((e) => e.k === 'edit' && e.a === 'Edit title')
  expect(typing.length).toBeGreaterThan(0)
  expect(typing.length).toBeLessThan(6)
})

test('the switch in Settings turns it off, and it stays off after a reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('topbar')).toBeVisible()
  await page.getByTestId('settings-open').click()
  const sw = page.getByTestId('settings-usage-log')
  await expect(sw).toHaveAttribute('aria-pressed', 'true')
  await expect(sw).toHaveText('On')
  // The line says what it is and where it lives, in plain words.
  await expect(page.getByTestId('settings-usage-where')).toContainText('kept in this browser')

  await sw.click()
  await expect(sw).toHaveAttribute('aria-pressed', 'false')
  await expect(sw).toHaveText('Off')
  expect(await page.evaluate(() => localStorage.getItem('olpremiere:settings:usage-log'))).toBe('off')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  const whileOff = await events(page)
  // The last thing written is the line that says it was switched off.
  expect(whileOff.at(-1)).toMatchObject({ k: 'session', a: 'log-off' })

  // Nothing he does now is kept.
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('m')
  await page.keyboard.press('s')
  await page.getByTestId('settings-open').click()
  await page.keyboard.press('Escape')
  expect((await events(page)).length).toBe(whileOff.length)

  // A new launch with it off keeps nothing, not even the line that says it started.
  await page.reload()
  await expect(page.getByTestId('topbar')).toBeVisible()
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('m')
  expect((await events(page)).length).toBe(whileOff.length)

  // And back on: it records again, and says so.
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-usage-log').click()
  await expect(page.getByTestId('settings-usage-log')).toHaveText('On')
  await page.keyboard.press('Escape')
  await page.keyboard.press('s')
  const back = await events(page)
  expect(names(back.slice(whileOff.length))).toEqual(expect.arrayContaining(['session log-on', 'key s']))
})

test('recording costs the interface nothing: a busy burst of edits and a playhead drag, log on and off', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // ⛔ THE BURSTS RUN INSIDE THE PAGE in one synchronous loop, the way edit-cost-at-scale
  // does: a Playwright mouse move is a round trip long enough to hide the cost. And each
  // half is timed in the same run, seconds apart, on the same machine, alternating, because
  // a number is only meaningful against its own twin. It asserts a RATIO, never a time.
  const result = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const settingsMod = '/src/state/settings.ts'
    const logMod = '/src/state/usageLog.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
      updateActiveSequence: (label: string, fn: (s: { markers?: unknown[] }) => unknown, key?: string) => void
    }
    const { setUsageLog } = (await import(/* @vite-ignore */ settingsMod)) as { setUsageLog: (on: boolean) => void }
    const { usage } = (await import(/* @vite-ignore */ logMod)) as { usage: { flush: () => Promise<void>; stats: () => { recorded: number } } }

    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
    // A drag: the playhead written on every pointer move, 6000 of them.
    const drag = (): number => {
      const t0 = performance.now()
      for (let i = 0; i < 6000; i++) useStore.getState().setUI({ playheadS: (i % 600) / 100 })
      return performance.now() - t0
    }
    // A busy edit: 300 undoable edits, in runs, the way typing and scrubbing commit.
    const edits = (): number => {
      const t0 = performance.now()
      for (let i = 0; i < 300; i++) {
        updateActiveSequence('Motion blur', (s) => ({ ...s, markers: [{ i }] }), `run:${i >> 5}`)
      }
      return performance.now() - t0
    }
    const rounds = 7
    // Three states, so each cost is isolated: the log ON (recording), OFF (the switch is off, but
    // the listeners and the store subscription are still installed and still run their checks),
    // and ABSENT (the whole wiring taken down: the app as it was before the log existed).
    const wiringMod = '/src/state/usageWiring.ts'
    const wiring = (await import(/* @vite-ignore */ wiringMod)) as { initUsageLog: () => () => void }
    const bucket = () => ({ drag: [] as number[], edits: [] as number[] })
    const runs = { on: bucket(), off: bucket(), absent: bucket() }
    drag()
    edits()
    for (let r = 0; r < rounds; r++) {
      for (const mode of ['on', 'off', 'absent'] as const) {
        if (mode === 'absent') wiring.initUsageLog()()
        else {
          wiring.initUsageLog()
          setUsageLog(mode === 'on')
        }
        await new Promise((res) => setTimeout(res, 30))
        runs[mode].drag.push(drag())
        runs[mode].edits.push(edits())
      }
    }
    wiring.initUsageLog()
    setUsageLog(true)
    await usage.flush()
    return {
      dragOn: median(runs.on.drag),
      dragOff: median(runs.off.drag),
      dragAbsent: median(runs.absent.drag),
      editsOn: median(runs.on.edits),
      editsOff: median(runs.off.edits),
      editsAbsent: median(runs.absent.edits),
      recorded: usage.stats().recorded,
    }
  })
  test.info().annotations.push({
    type: 'cost',
    description:
      `6000 playhead writes: ${result.dragOn.toFixed(1)}ms on, ${result.dragOff.toFixed(1)}ms off, ${result.dragAbsent.toFixed(1)}ms without the log at all. ` +
      `300 edits: ${result.editsOn.toFixed(1)}ms on, ${result.editsOff.toFixed(1)}ms off, ${result.editsAbsent.toFixed(1)}ms without.`,
  })
  console.log(`usage-log cost: ${JSON.stringify(result)}`)
  // It did record while it was on, so the comparison is between something and nothing.
  expect(result.recorded).toBeGreaterThan(10)
  // A drag writes no events at all, so the log must not move it, with or without the switch.
  expect(result.dragOn).toBeLessThan(result.dragAbsent * 1.35 + 5)
  expect(result.dragOff).toBeLessThan(result.dragAbsent * 1.35 + 5)
  // The edits record a line each run, and may cost a little more than not recording, but
  // never a different order of cost.
  expect(result.editsOn).toBeLessThan(result.editsAbsent * 1.5 + 8)
})
