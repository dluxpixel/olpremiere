// @vitest-environment jsdom
//
// The usage log's connection to the running app: what a click, a key press into a field, a
// toast, an error, a playing timeline and a switch of project become in the log, that the
// switch in Settings really stops it, and that taking the wiring down leaves nothing behind.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'
import { setUsageLog, useSettings } from './settings'
import { useStore } from './store'
import { useToasts } from './toasts'
import { usage, type UsageEvent } from './usageLog'
import { setKnownNames } from './usageNames'
import { countScriptEventsForTests, initUsageLog } from './usageWiring'

countScriptEventsForTests()

let stop: () => void
let lines: string[]

const events = async (): Promise<UsageEvent[]> => {
  await usage.flush()
  return lines.flatMap((l) => l.trim().split('\n')).filter(Boolean).map((l) => JSON.parse(l) as UsageEvent)
}
/** Everything but the project lines, which come with his first input and are tested on their own. */
const mine = async (): Promise<[string, string][]> => (await events()).filter((e) => e.k !== 'project').map((e) => [e.k, e.a])

const page = (html: string): HTMLElement => {
  document.body.innerHTML = html
  return document.body
}

const fire = (el: Element, type: string, init: object = {}): void => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 4, 10, 0, 0))
  lines = []
  useStore.getState().setProject(newProject())
  useSettings.setState({ usageLog: true })
  await usage.setEnabled(true)
  stop = initUsageLog()
  usage.attach(async (_day, text) => {
    lines.push(text)
  })
  await usage.flush()
  lines.length = 0
})

afterEach(() => {
  stop()
  document.body.innerHTML = ''
  setKnownNames(() => [])
  vi.useRealTimers()
})

describe('buttons, menus and toggles', () => {
  it('names a click by its testid and says which part of the app it was in', async () => {
    const b = page('<header data-testid="topbar"><button data-testid="settings-open" aria-label="Settings">gear</button></header>')
    fire(b.querySelector('button')!, 'click')
    const ui = (await events()).filter((e) => e.k === 'ui')
    expect(ui).toMatchObject([{ a: 'settings-open', d: { panel: 'topbar', role: 'button' } }])
  })

  it('finds the button from an icon inside it', async () => {
    const b = page('<aside data-testid="panel-left"><button data-testid="asset-add"><svg><path id="p"/></svg></button></aside>')
    fire(b.querySelector('#p')!, 'click')
    expect((await events()).find((e) => e.k === 'ui')).toMatchObject({ a: 'asset-add', d: { panel: 'left' } })
  })

  it('says whether a toggle went on or off', async () => {
    const b = page(`
      <button id="p" data-testid="snap-toggle" aria-pressed="false">Snap</button>
      <button id="q" data-testid="loop-toggle" aria-pressed="true">Loop</button>
      <input id="c" type="checkbox" data-testid="studio-monitor" />`)
    fire(b.querySelector('#p')!, 'click')
    fire(b.querySelector('#q')!, 'click')
    const box = b.querySelector<HTMLInputElement>('#c')!
    box.click()
    expect((await events()).filter((e) => e.k === 'ui').map((e) => [e.a, e.d?.on])).toEqual([
      ['snap-toggle', true],
      ['loop-toggle', false],
      ['studio-monitor', true],
    ])
  })

  it('records a menu item by its words and ignores a click on nothing in particular', async () => {
    const b = page('<div role="menu"><button role="menuitem">Split</button></div><p id="nothing">hello</p>')
    fire(b.querySelector('button')!, 'click')
    fire(b.querySelector('#nothing')!, 'click')
    expect((await events()).filter((e) => e.k === 'ui')).toMatchObject([{ a: 'Split', d: { panel: 'menu', role: 'menuitem' } }])
  })

  it('records a press on something that is not a button, once, and never the click on a real button twice', async () => {
    const b = page('<section data-testid="timeline"><div data-testid="clip" id="c"></div><button data-testid="add-title" id="b">T</button></section>')
    fire(b.querySelector('#c')!, 'pointerdown', { button: 0 })
    fire(b.querySelector('#b')!, 'pointerdown', { button: 0 })
    fire(b.querySelector('#b')!, 'click')
    // A right button press is a context menu, not a press.
    fire(b.querySelector('#c')!, 'pointerdown', { button: 2 })
    expect((await events()).filter((e) => e.k === 'ui').map((e) => [e.a, e.d?.role])).toEqual([
      ['clip', 'pointer'],
      ['add-title', 'button'],
    ])
  })

  it('records which text field he clicked into and never what is in it', async () => {
    const b = page('<div data-testid="panel-right"><textarea data-testid="title-text" id="t"></textarea></div>')
    const field = b.querySelector<HTMLTextAreaElement>('#t')!
    field.value = 'MY SECRET WORDS'
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    const list = await events()
    expect(list.filter((e) => e.k === 'ui')).toMatchObject([{ a: 'title-text', d: { panel: 'right', role: 'text' } }])
    expect(JSON.stringify(list)).not.toContain('SECRET')
  })

  it('records that a select or a slider changed, never to what', async () => {
    const b = page(`
      <select data-testid="settings-language"><option value="cs">Czech secret</option></select>
      <input type="range" data-testid="clip-volume-slider" value="42" />`)
    b.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }))
    b.querySelector('input')!.dispatchEvent(new Event('change', { bubbles: true }))
    const list = (await events()).filter((e) => e.k === 'ui')
    expect(list.map((e) => [e.a, e.d?.role])).toEqual([
      ['settings-language', 'select'],
      ['clip-volume-slider', 'slider'],
    ])
    expect(JSON.stringify(list)).not.toMatch(/cs|Czech|42/)
  })

  it('records that a file picker was used and how many files, never which', async () => {
    const b = page('<aside data-testid="panel-left"><input type="file" data-testid="media-file-input" multiple /></aside>')
    b.querySelector('input')!.dispatchEvent(new Event('change', { bubbles: true }))
    expect((await events()).filter((e) => e.k === 'ui')).toMatchObject([
      { a: 'media-file-input', d: { panel: 'left', role: 'file', n: 0 } },
    ])
  })

  it('records a right click by the thing it was on', async () => {
    const b = page('<section data-testid="timeline"><div data-testid="clip" id="c"></div></section>')
    fire(b.querySelector('#c')!, 'contextmenu')
    expect((await events()).filter((e) => e.k === 'ui')).toMatchObject([{ a: 'context-menu', d: { on: 'clip', panel: 'timeline' } }])
  })
})

describe('dialogs', () => {
  it('sees one open and close after what he did, stamped when HE acted, with how long it was open', async () => {
    const b = page('<button id="o" data-testid="settings-open">gear</button>')
    fire(b.querySelector('#o')!, 'click')
    const openedAt = Date.now()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-testid', 'settings-dialog')
    document.body.appendChild(dialog)
    await vi.advanceTimersByTimeAsync(5)
    vi.setSystemTime(openedAt + 4_000)
    dialog.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.advanceTimersByTimeAsync(5)
    const list = (await events()).filter((e) => e.k === 'dialog')
    expect(list.map((e) => [e.a, e.d?.op])).toEqual([
      ['settings-dialog', 'open'],
      ['settings-dialog', 'close'],
    ])
    expect(list[0]!.t).toBe(openedAt)
    expect(list[1]!.ms).toBe(4_000)
  })

  it('does not count the start up cards as something he opened', async () => {
    const b = page('<button id="o">x</button><div role="dialog" data-testid="boot-splash"></div>')
    fire(b.querySelector('#o')!, 'click')
    await vi.advanceTimersByTimeAsync(400)
    expect((await events()).filter((e) => e.k === 'dialog')).toEqual([])
  })
})

describe('projects, playing and zooming', () => {
  it('opens a project on his first input, and writes a close and a switch when it changes', async () => {
    const b = page('<button id="o" data-testid="tab-media">m</button>')
    const first = useStore.getState().project.id
    fire(b.querySelector('#o')!, 'click')
    useStore.getState().setProject(newProject())
    const second = useStore.getState().project.id
    fire(b.querySelector('#o')!, 'click')
    const list = await events()
    expect(list.map((e) => [e.k, e.a, e.p])).toEqual([
      ['project', 'open', first],
      ['ui', 'tab-media', first],
      ['project', 'close', first],
      ['project', 'switch', second],
      ['ui', 'tab-media', second],
    ])
    expect(list[0]!.d).toMatchObject({ clips: 0 })
  })

  it('writes a play with how long it ran and how far, and ignores a tap', async () => {
    const b = page('<button id="o">x</button>')
    fire(b.querySelector('#o')!, 'click')
    useStore.getState().setUI({ playing: true, playheadS: 1 })
    await vi.advanceTimersByTimeAsync(2_500)
    useStore.getState().setUI({ playing: false, playheadS: 3.5 })
    useStore.getState().setUI({ playing: true })
    await vi.advanceTimersByTimeAsync(50)
    useStore.getState().setUI({ playing: false })
    const plays = (await events()).filter((e) => e.k === 'play')
    expect(plays).toHaveLength(1)
    expect(plays[0]).toMatchObject({ a: 'playback', ms: 2_500, d: { sec: 2.5, loop: false } })
  })

  it('writes one line for a whole zoom gesture: where it began and where it settled', async () => {
    useStore.getState().setUI({ pxPerS: 60 })
    await vi.advanceTimersByTimeAsync(700)
    lines.length = 0
    for (const z of [70, 85, 100, 140]) useStore.getState().setUI({ pxPerS: z })
    await vi.advanceTimersByTimeAsync(700)
    expect((await events()).filter((e) => e.k === 'zoom')).toMatchObject([{ a: 'timeline-zoom', d: { from: 60, to: 140 } }])
  })
})

describe('what he was shown', () => {
  it('writes a toast with his names, files and numbers taken out, and an error as an error', async () => {
    setKnownNames(() => [{ name: 'Quarterly review', as: 'project' }])
    useToasts.getState().show('Export finished: Gym day 4 final.mp4 (31.4 MB)', 'success')
    useToasts.getState().show('The export of Quarterly review failed: disk full', 'danger')
    const list = await events()
    expect(list).toMatchObject([
      { k: 'toast', a: 'Export finished: <file.mp4> (# MB)', d: { level: 'success' } },
      { k: 'error', a: 'The export of <project> failed: disk full', d: { src: 'toast' } },
    ])
    expect(JSON.stringify(list)).not.toMatch(/Gym|Quarterly|31/)
  })

  it('does not write the toast that only repeats an undo, which is a line of its own', async () => {
    useToasts.getState().show('Undo: Split clip')
    useToasts.getState().show('Redo: Split clip')
    expect(await events()).toEqual([])
  })

  it('writes an uncaught error, masked, and no more than a few a minute', async () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'Cannot read C:\\Users\\skyle\\Desktop\\secret.mp4 of undefined' }))
    for (let i = 0; i < 60; i++) window.dispatchEvent(new ErrorEvent('error', { message: `loop ${i}` }))
    const list = await events()
    expect(list[0]).toMatchObject({ k: 'error', d: { src: 'uncaught' } })
    expect(list[0]!.a).not.toMatch(/skyle|secret/)
    expect(list.length).toBe(20)
  })
})

describe('the switch in Settings, and taking it all down', () => {
  it('stops the moment it is switched off, says so, and starts again when it is on', async () => {
    const b = page('<button id="o" data-testid="snap-toggle">x</button>')
    fire(b.querySelector('#o')!, 'click')
    setUsageLog(false)
    await vi.advanceTimersByTimeAsync(5)
    fire(b.querySelector('#o')!, 'click')
    useToasts.getState().show('Project saved')
    expect((await mine()).map(([k, a]) => `${k} ${a}`)).toEqual(['ui snap-toggle', 'session log-off'])
    setUsageLog(true)
    await vi.advanceTimersByTimeAsync(5)
    fire(b.querySelector('#o')!, 'click')
    expect((await mine()).map(([k, a]) => `${k} ${a}`)).toEqual(['ui snap-toggle', 'session log-off', 'session log-on', 'ui snap-toggle'])
  })

  it('leaves nothing listening once it is stopped', async () => {
    const b = page('<button id="o" data-testid="snap-toggle">x</button>')
    stop()
    fire(b.querySelector('#o')!, 'click')
    useToasts.getState().show('Something happened')
    window.dispatchEvent(new ErrorEvent('error', { message: 'after' }))
    expect(await events()).toEqual([])
  })

  it('writes the start of a launch with the version and the shell, and its end as the page goes', async () => {
    stop()
    useSettings.setState({ usageLog: true })
    lines = []
    await usage.setEnabled(true)
    stop = initUsageLog()
    usage.attach(async (_day, text) => {
      lines.push(text)
    })
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(5)
    const list = (await events()).filter((e) => e.k === 'session')
    expect(list.map((e) => e.a)).toEqual(['start', 'end'])
    expect(list[0]!.d).toMatchObject({ shell: 'web', phone: false })
    expect(list[0]!.d?.v).toMatch(/\d/)
  })
})
