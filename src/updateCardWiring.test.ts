// The update card's wiring, guarded at the source level.
//
// These read files rather than run a window, because the things that break here
// break silently and only in a packaged build on his machine: a missing rollup
// entry is a blank always-on-top rectangle, a stolen focus is his keystrokes going
// somewhere other than his caption, and a bare `quitAndInstall` is a truncated
// render. None of those raise an error anywhere.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const main = read('electron/main.ts')
const update = read('src/splash/update.ts')
const viteConfig = read('electron.vite.config.ts')
const css = read('src/splash/splash.css')

describe('the update window is built and served', () => {
  // Symptom if this fails: the packaged app opens a blank transparent window,
  // because app:// 404s on a page rollup never emitted. Dev is fine, so it would
  // only ever be found by him.
  it('is a rollup entry', () => {
    expect(viteConfig).toContain("update: 'update.html'")
  })

  it('loads the same stylesheet as the opening screen', () => {
    expect(update).toContain("import './splash.css'")
  })
})

describe('it never takes the keyboard off his timeline', () => {
  // ⛔ The splash may call show() and focus(); it runs when nothing else is on
  // screen. This window opens over a running editor.
  it('shows without activating, and never focuses', () => {
    const fn = main.slice(main.indexOf('function createUpdateWindow'), main.indexOf('function shrinkUpdate'))
    expect(fn).not.toMatch(/win\.show\(\)/)
    expect(fn).not.toMatch(/win\.focus\(\)/)
    expect(main).toMatch(/update:show[\s\S]{0,120}showInactive/)
  })

  it('shrinks without focusing, unlike the splash', () => {
    const fn = main.slice(main.indexOf('function shrinkUpdate'), main.indexOf('function shrinkUpdate') + 900)
    expect(fn).not.toMatch(/\bwin\.focus\(\)/)
  })
})

describe('the melon restarts safely or not at all', () => {
  // ⛔ update:install is a bare quitAndInstall with no busy check. Routing through
  // the renderer is what stops a restart mid-export truncating a render.
  it('routes the click through the renderer decision, not quitAndInstall', () => {
    const start = main.indexOf("ipcMain.on('update:apply'")
    // End at the handler's own closing brace, not a fixed window: a slice that
    // overran picked up an unrelated quitAndInstall further down the file.
    const handler = main.slice(start, main.indexOf('\n  })', start))
    expect(handler).toContain('update:autoApply')
    // The CALL, not the word: the handler's own comment names it to explain why it
    // is not used, and a bare substring match reads that as the thing it forbids.
    expect(handler).not.toMatch(/autoUpdater\.quitAndInstall/)
    expect(update).toContain('updateApply')
    expect(update).not.toContain('restartToUpdate')
  })
})

describe('it never opens over the splash, or unasked', () => {
  it('refuses while the boot card is still up', () => {
    const fn = main.slice(main.indexOf('function armUpdateWindow'), main.indexOf('function createUpdateWindow'))
    expect(fn).toMatch(/!entered \|\| splashWindow/)
  })

  it('requires his click unless the switch is flipped', () => {
    const fn = main.slice(main.indexOf('function armUpdateWindow'), main.indexOf('function createUpdateWindow'))
    expect(fn).toContain('userAsked')
    expect(fn).toContain('UPDATE_SCREEN_UNBIDDEN')
  })

  it('lets a terminal answer end his click authority', () => {
    const fn = main.slice(main.indexOf('function setUpdateStatus'), main.indexOf('function setUpdateStatus') + 800)
    expect(fn).toMatch(/userAsked = false/)
  })
})

describe('a check can never blank a live download', () => {
  it('the poll steps aside while bytes are arriving', () => {
    expect(main).toMatch(/if \(updateStatus\.kind === 'downloading'\) return/)
  })
})

describe('his click always registers, whatever the updater is already doing', () => {
  // ⛔ HIS WORDS, 2026-08-24: "clicking the melon doesn't really update the app.
  // There's still no updating animation." `autoDownload` is on, so a version is
  // usually ALREADY arriving by the time he clicks. `userAsked = true` sat BELOW
  // the downloading guard, so on the one path he was most likely to take, his
  // click returned before it registered: no card, because armUpdateWindow needs
  // the flag, and no reload either, because reloadAndCheckForUpdates refuses to
  // reload on top of a found update. The melon did nothing at all.
  const handler = main.slice(main.indexOf("ipcMain.handle('update:check'"), main.indexOf("ipcMain.on('update:busy'"))

  it('sets his flag before any early return in the check handler', () => {
    const flag = handler.indexOf('userAsked = true')
    const guard = handler.indexOf("updateStatus.kind === 'downloading'")
    expect(flag).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(flag).toBeLessThan(guard)
  })

  it('answers a click during a live download by arming the card, not by returning', () => {
    expect(handler).toContain('armUpdateWindow(updateStatus)')
  })

  it('answers a click on an already-downloaded update by opening the card', () => {
    // There is no download left to animate; silence is not the honest answer,
    // the card in its finished state is, and its melon is what applies it.
    const done = handler.slice(handler.indexOf("updateStatus.kind === 'downloaded'"))
    expect(done).toContain('createUpdateWindow()')
  })

  it('still refuses to open a second card, or one over the boot splash', () => {
    const done = handler.slice(handler.indexOf("updateStatus.kind === 'downloaded'"))
    expect(done).toContain('!updateWindow')
    expect(done).toContain('!splashWindow')
    expect(done).toContain('entered')
  })
})

describe('the card borrows every beat rather than inventing one', () => {
  // If a raw 300 is typed into update.ts, the card will one day vanish mid-exit.
  it('uses the shared exit timing, not a number', () => {
    expect(update).toContain('SPLASH_CARD_EXIT_MS')
    expect(update).not.toMatch(/setTimeout\([^,]+,\s*300\)/)
  })

  it('adds no keyframe of its own', () => {
    const own = css.slice(css.indexOf("the update card"))
    expect(own).not.toContain('@keyframes')
  })

  it('gives the card room for the brand bloom', () => {
    const own = css.slice(css.indexOf("the update card"))
    expect(own).toMatch(/min-height:\s*400px/)
  })
})
