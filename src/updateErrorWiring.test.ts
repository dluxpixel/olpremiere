// The failed-check wiring, guarded at the source level like updateCardWiring.test.ts.
//
// These read files rather than run the app, because what breaks here breaks only in a
// packaged build on his machine, mid release, and raises nothing: on 2026-10-04 the
// updater's raw text (a URL, the response headers, a stack trace) went straight into a
// toast. The judgement itself is tested in electron/updateErrors.test.ts; this proves
// the two ends still ROUTE through it.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const main = read('electron/main.ts')
const app = read('src/App.tsx')

const errorHandler = main.slice(main.indexOf("autoUpdater.on('error'"), main.indexOf("autoUpdater.on('update-not-available'"))
const toastHandler = app.slice(app.indexOf('olApi?.onUpdateError'), app.indexOf('On the FIRST launch after an auto-update'))

describe('main answers a failed check through planUpdateError', () => {
  it('found the handler it is about to inspect', () => {
    expect(errorHandler.length).toBeGreaterThan(200)
    expect(toastHandler.length).toBeGreaterThan(100)
  })

  it('keeps the full text in the log, and sends the renderer only the planned sentence', () => {
    expect(errorHandler).toContain('planUpdateError(e, publishingStreak)')
    expect(errorHandler).toContain('appendUpdateLog(')
    expect(errorHandler).toContain("send('update:error', plan.message)")
    expect(errorHandler).toContain("setUpdateStatus({ kind: 'error', message: plan.message })")
  })

  it('⛔ never forwards the updater\'s own message', () => {
    expect(errorHandler).not.toMatch(/send\('update:error',\s*(msg|e\b|e\.)/)
    expect(errorHandler).not.toMatch(/message:\s*(msg|e\.message)/)
  })

  it('says nothing for a release still publishing, and looks again, BEFORE anything is sent', () => {
    const quiet = errorHandler.indexOf('plan.message === null')
    expect(quiet).toBeGreaterThan(-1)
    expect(errorHandler.indexOf("setUpdateStatus({ kind: 'pending' })")).toBeGreaterThan(quiet)
    expect(errorHandler.indexOf('recheckSoon(plan.retryInMs)')).toBeGreaterThan(quiet)
    expect(errorHandler.indexOf("send('update:error'")).toBeGreaterThan(errorHandler.indexOf('return'))
  })

  it('a found update, or none, ends a streak of quiet answers', () => {
    expect(main).toMatch(/update-not-available[\s\S]{0,80}publishingStreak = 0/)
    expect(main).toMatch(/update-available[\s\S]{0,80}publishingStreak = 0/)
  })

  it('a quiet answer ends his click\'s authority like any other terminal answer', () => {
    expect(main).toContain("status.kind === 'pending'")
  })
})

describe('the renderer toast', () => {
  it('shows only what updateErrorToast lets through, never the raw message', () => {
    expect(toastHandler).toContain('updateErrorToast(message)')
    expect(toastHandler).not.toMatch(/\$\{message\}/)
  })
})
