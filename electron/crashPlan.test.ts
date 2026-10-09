// A page that dies is loaded again and the reason is written down; a page that keeps
// dying stops and says so. Until 2026-10-06 a crashed editor stayed a blank window.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CRASH_WINDOW_MS, crashLogLine, crashPlan, MAX_RELOADS } from './crashPlan'

const NOW = 1_000_000_000

describe('crashPlan', () => {
  it('does nothing for a page that ended on purpose', () => {
    expect(crashPlan('clean-exit', [], NOW)).toBe('nothing')
    expect(crashPlan('clean-exit', [NOW - 1000, NOW - 2000], NOW)).toBe('nothing')
  })

  it.each(['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'memory-eviction', 'something new'])(
    'reloads a page that died with %s',
    (reason) => {
      expect(crashPlan(reason, [], NOW)).toBe('reload')
    },
  )

  it('reloads twice inside five minutes, and stops on the third', () => {
    expect(MAX_RELOADS).toBe(2)
    expect(CRASH_WINDOW_MS).toBe(5 * 60_000)
    expect(crashPlan('crashed', [NOW - 60_000], NOW)).toBe('reload')
    expect(crashPlan('oom', [NOW - 120_000, NOW - 60_000], NOW)).toBe('stop')
  })

  it('forgets deaths older than five minutes', () => {
    expect(crashPlan('crashed', [NOW - CRASH_WINDOW_MS, NOW - CRASH_WINDOW_MS - 1], NOW)).toBe('reload')
    expect(crashPlan('crashed', [NOW - CRASH_WINDOW_MS, NOW - 1000], NOW)).toBe('reload')
  })
})

describe('crashLogLine', () => {
  const at = new Date('2026-10-06T12:00:00.000Z')

  it('says when, why, and which version, on one line', () => {
    const line = crashLogLine(at, 'editor page gone', { reason: 'oom', exitCode: -536870904 }, '3.22.0', 'reload')
    expect(line).toBe('2026-10-06T12:00:00.000Z editor page gone reason=oom exitCode=-536870904 version=3.22.0 then=reload\n')
  })

  it('names a child process by its type', () => {
    expect(crashLogLine(at, 'child process gone', { reason: 'crashed', exitCode: 1, type: 'GPU' }, '3.22.0')).toContain(
      'type=GPU',
    )
  })

  it('stays one line whatever it is handed', () => {
    const line = crashLogLine(at, 'x', { reason: 'a\nb', name: 'c\r\nd' }, '1')
    expect(line.split('\n')).toHaveLength(2)
    expect(line.endsWith('\n')).toBe(true)
  })
})

// main.ts cannot be imported here (electron), so the wiring of the "stopped" box is
// pinned at the source, and run for real by scripts/hidden-app/checks/crash-stop.cjs.
describe('the "OL Premiere stopped" box', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const gone = main.slice(main.indexOf('function onEditorGone('), main.indexOf('function closeWhenGone('))
  const stop = gone.slice(gone.indexOf('const box ='))
  const boxAt = stop.indexOf('dialog.showMessageBox(')

  it('⛔ opens only after the always on top cards are gone and the boot backstop is off', () => {
    expect(boxAt).toBeGreaterThan(0)
    for (const step of ['editorStopped = true', 'clearTimeout(bootBackstop)', 'card.destroy()']) {
      expect(stop.indexOf(step), step).toBeGreaterThan(0)
      expect(stop.indexOf(step), step).toBeLessThan(boxAt)
    }
    expect(stop).toMatch(/for \(const card of \[splashWindow, updateWindow\]\)/)
  })

  it('has the editor as its parent only when the editor is really on his screen', () => {
    expect(stop).toContain('const onScreen = win.isVisible() && !win.isMinimized()')
    expect(stop).toContain('onScreen ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)')
  })

  it('⛔ the dead editor is never put on screen afterwards, by the backstop or a card closing', () => {
    const enter = main.slice(main.indexOf('function enterEditor('), main.indexOf('function enterEditor(') + 200)
    expect(enter).toContain('if (entered || editorStopped) return')
    // Every route that shows the editor goes through revealEditor, the editor's own
    // ready-to-show included.
    const reveal = main.slice(main.indexOf('function revealEditor('), main.indexOf('function createSplash('))
    expect(reveal).toMatch(/^\s*if \(editorStopped\) return$/m)
    expect(reveal.indexOf('if (editorStopped) return')).toBeLessThan(reveal.indexOf('win.'))
    const arm = main.slice(main.indexOf('function armUpdateWindow('), main.indexOf('function createUpdateWindow('))
    expect(arm).toContain('if (editorStopped) return')
  })
})

// ⛔ A crash is not reloaded while the app is quitting, and `quitting` is set by
// before-quit. A quit can be called off after that: the update install's fallback quit
// meets a page that refuses to unload during an export, and he picks "Keep exporting".
// Left set, every later crash of that session stayed a blank window.
describe('a quit he called off', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const unload = main.slice(main.indexOf("win.webContents.on('will-prevent-unload'"), main.indexOf('if (isDev) {'))

  it('⛔ turns the crash reload back on when he keeps the page', () => {
    expect(unload).toMatch(/if \(choice === 0\) \{\s*quitting = false/)
    // Decided before the page's refusal is overruled or kept, never instead of it.
    expect(unload.indexOf('quitting = false')).toBeLessThan(unload.indexOf('if (choice === 1) e.preventDefault()'))
    expect(main).toMatch(/app\.on\('before-quit', \(\) => \{\s+quitting = true/)
  })
})

// ⛔ The same choice calls off a waiting update install. The install's 12 s fallback was
// armed when the close passed the gate, before the page refused to unload; left running it
// installed over the export he had just chosen to keep, and its phase then held
// installWait.pending() true for good, which switches the crash reload off.
describe('keeping an export while an update waits', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const unload = main.slice(main.indexOf("win.webContents.on('will-prevent-unload'"), main.indexOf('if (isDev) {'))

  it('⛔ stops the waiting install along with the quit', () => {
    const kept = unload.slice(unload.indexOf('if (choice === 0) {'), unload.indexOf('if (choice === 1) e.preventDefault()'))
    expect(kept).toContain('quitting = false')
    expect(kept).toContain('installWait.cancel()')
  })
})

// ⛔ A window that is closing is not a crash. When the page dies mid save the gate closes
// the window on the spot (closeGate pageGone), and the reload in onEditorGone must not run
// on it. Everything else that ends a page on purpose is in the same guard.
describe('a page that dies while the app is leaving', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const gone = main.slice(main.indexOf('function onEditorGone('), main.indexOf('function closeWhenGone('))
  const guard = gone.slice(gone.indexOf('if ('), gone.indexOf('const now = Date.now()'))

  it('⛔ does not reload while an update install waits, while quitting, once destroyed, or while its window closes', () => {
    for (const part of ['quitting', 'installWait.pending()', 'win.isDestroyed()', 'closeGates.get(win.webContents)?.closing()']) {
      expect(guard, part).toContain(part)
    }
    expect(guard).toMatch(/\) return\s*$/)
    // A destroyed window has no webContents to read, so it is asked first.
    expect(guard.indexOf('win.isDestroyed()')).toBeLessThan(guard.indexOf('closeGates.get(win.webContents)'))
    expect(gone.indexOf('crashPlan(')).toBeGreaterThan(gone.indexOf('closeGates.get(win.webContents)'))
  })
})
