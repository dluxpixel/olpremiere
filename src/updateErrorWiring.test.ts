// The failed-check wiring, guarded at the source level like updateCardWiring.test.ts.
//
// What breaks here breaks only in a packaged build on his machine, mid release, and
// raises nothing: on 2026-10-04 the updater's raw text (a URL, the response headers, a
// stack trace) went straight into a toast. Since 2026-10-06 the rules themselves (quiet
// while publishing, said out loud after an hour, a dead feed said at once, streaks, the
// poll) are RUN in electron/updateFlow.test.ts with a fake updater and fake clocks. What
// is left here is only that main hands that flow the real updater, and that the two ends
// still route through the fixed sentences.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const main = read('electron/main.ts')
const flow = read('electron/updateFlow.ts')
const app = read('src/App.tsx')

const toastHandler = app.slice(app.indexOf('olApi?.onUpdateError'), app.indexOf('On the FIRST launch after an auto-update'))
/** Code only, so a comment that names a forbidden call to explain why is not read as the call. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('main runs the updater through ./updateFlow', () => {
  it('hands the flow the real updater and its own status', () => {
    expect(main).toMatch(/startUpdateFlow\(\{\s*updater: autoUpdater,/)
    expect(main).toContain('setStatus: setUpdateStatus')
    expect(main).toContain('getStatus: () => updateStatus')
  })

  it('his reload button checks through the same flow', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('update:check'"), main.indexOf("ipcMain.on('update:busy'"))
    expect(handler).toContain('updateFlow?.check()')
  })

  // ⛔ 2026-10-06. checkForUpdatesAndNotify also puts up a Windows notification for every
  // finished download, about twice a day, on top of the app's own toast and card.
  it('⛔ never asks Windows for a notification', () => {
    for (const src of [main, flow]) {
      expect(code(src)).not.toContain('checkForUpdatesAndNotify')
      expect(code(src)).not.toMatch(/\bNotification\b/)
    }
  })

  it('a quiet answer ends his click\'s authority like any other terminal answer', () => {
    expect(main).toContain("status.kind === 'pending'")
  })
})

describe('the renderer toast', () => {
  it('shows only what updateErrorToast lets through, never the raw message', () => {
    expect(toastHandler.length).toBeGreaterThan(100)
    expect(toastHandler).toContain('updateErrorToast(message)')
    expect(toastHandler).not.toMatch(/\$\{message\}/)
  })
})
