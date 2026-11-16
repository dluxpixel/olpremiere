/**
 * @vitest-environment jsdom
 *
 * The small bar that floats over a title while it is typed on, in TikTok text mode: a style button
 * that cycles the four TikTok looks, an alignment button, and a row of colour dots. It styles THIS
 * title and leaves its words, position and size alone.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { contrastTextColor } from '../engine/render/lineBox'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip, type TitleDef } from '../engine/types'
import { setTiktokMode } from '../state/settings'
import { updateActiveSequence, useStore } from '../state/store'
import { titleLookById } from '../state/titleShelf'
import { endTextEdit, useTextEdit } from './MonitorTextEdit'
import { TIKTOK_DOTS, TikTokTextBar } from './TikTokTextBar'

const clipOf = (id: string): Clip =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const titleOf = (id: string): TitleDef => clipOf(id).title!

let barW = 240
let barH = 36
const CONTAINER = { w: 400, h: 700 }

const SIZE_PROPS = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

beforeEach(() => {
  localStorage.clear()
  setTiktokMode(true)
  endTextEdit()
  barW = 240
  barH = 36
  // jsdom lays nothing out, so the bar's own size and the monitor's are given here.
  const sizes = { offsetWidth: () => barW, offsetHeight: () => barH, clientWidth: () => CONTAINER.w, clientHeight: () => CONTAINER.h }
  for (const prop of SIZE_PROPS) {
    saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop))
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: sizes[prop] })
  }
  useStore.getState().setProject(newProject('p', { w: 1080, h: 1920 }))
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
})
afterEach(() => {
  cleanup()
  endTextEdit()
  for (const prop of SIZE_PROPS) {
    const d = saved.get(prop)
    if (d) Object.defineProperty(HTMLElement.prototype, prop, d)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  }
  setTiktokMode(false)
})

/** A title in the TikTok plain look at a made-up offset, so "keeps its position and size" can be told. */
function seed(over: Partial<TitleDef> = {}): Clip {
  const look = titleLookById('tiktok-plain')!
  const clip = newTitleClip({ ...defaultTitleDef('two\nlines'), ...look.style, offsetXPx: 30, offsetYPx: -40, ...over }, 0, 3)
  clip.transform = { ...clip.transform, x: -65, y: -145, scale: 1.25 }
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  useStore.getState().setUI({ selection: [clip.id] })
  return clip
}

const edit = (clipId: string, box: { left: number; top: number; w: number; h: number } | null = { left: 100, top: 300, w: 200, h: 80 }) =>
  act(() => useTextEdit.setState({ editing: { clipId, box, rotationDeg: 0 } }))

const mount = () => render(<div data-testid="host"><TikTokTextBar /></div>)

describe('when the bar shows', () => {
  it('is not there with the mode off, or when nothing is being typed on, or before the box is measured', () => {
    const c = seed()
    setTiktokMode(false)
    mount()
    edit(c.id)
    expect(screen.queryByTestId('tiktok-text-bar')).toBeNull()
    act(() => setTiktokMode(true))
    expect(screen.getByTestId('tiktok-text-bar')).toBeTruthy()
    edit(c.id, null)
    expect(screen.queryByTestId('tiktok-text-bar')).toBeNull()
    act(() => endTextEdit())
    expect(screen.queryByTestId('tiktok-text-bar')).toBeNull()
  })

  it('sits just above the text box, centred on it', () => {
    const c = seed()
    mount()
    edit(c.id) // box left 100, top 300, 200 x 80
    const bar = screen.getByTestId('tiktok-text-bar')
    expect(bar.style.top).toBe(`${300 - barH - 6}px`)
    expect(bar.style.left).toBe(`${100 + 100 - barW / 2}px`)
  })

  it('flips below the box when there is no room above', () => {
    const c = seed()
    mount()
    edit(c.id, { left: 100, top: 20, w: 200, h: 80 })
    expect(screen.getByTestId('tiktok-text-bar').style.top).toBe(`${20 + 80 + 6}px`)
  })

  it('stays inside the monitor sideways', () => {
    const c = seed()
    mount()
    edit(c.id, { left: 0, top: 300, w: 40, h: 80 })
    expect(screen.getByTestId('tiktok-text-bar').style.left).toBe('4px')
    edit(c.id, { left: 360, top: 300, w: 40, h: 80 })
    expect(screen.getByTestId('tiktok-text-bar').style.left).toBe(`${CONTAINER.w - barW - 4}px`)
  })

  it('wears the app look: the elevated panel, the overlay radius token, a keep-typing marker', () => {
    const c = seed()
    mount()
    edit(c.id)
    const bar = screen.getByTestId('tiktok-text-bar')
    expect(bar.className).toContain('rounded-overlay')
    expect(bar.className).toContain('bg-bg-elevated')
    expect(bar.hasAttribute('data-keeps-text-edit')).toBe(true)
  })

  it('a press on the bar does not take the focus off the field, and does not reach the picture under it', () => {
    const c = seed()
    const reached = vi.fn()
    render(
      <div onPointerDown={reached}>
        <TikTokTextBar />
      </div>,
    )
    edit(c.id)
    const bar = screen.getByTestId('tiktok-text-bar')
    expect(fireEvent.mouseDown(screen.getByTestId('tiktok-style'))).toBe(false) // default prevented
    fireEvent.pointerDown(bar)
    expect(reached).not.toHaveBeenCalled()
  })
})

describe('the A button cycles the four TikTok looks on this title', () => {
  const STYLE_KEYS = ['highlight', 'soft', 'outline', 'plain'] as const
  const LOOK_OF = { plain: 'tiktok-plain', highlight: 'tiktok-highlight', soft: 'tiktok-soft', outline: 'tiktok-outline' } as const

  it('goes plain, highlight, soft, outline and round again, each with that look styling', () => {
    const c = seed()
    mount()
    edit(c.id)
    const a = screen.getByTestId('tiktok-style')
    expect(a.getAttribute('data-style')).toBe('plain')
    for (const key of STYLE_KEYS) {
      fireEvent.click(a)
      expect(a.getAttribute('data-style'), key).toBe(key)
      const want = titleLookById(LOOK_OF[key])!.style
      const t = titleOf(c.id)
      expect(t.color).toBe(want.color)
      expect(t.lineBox).toEqual(want.lineBox)
      expect(t.outline).toEqual(want.outline)
      expect(t.shadow).toEqual(want.shadow)
    }
  })

  it('keeps its words, position and size on every step', () => {
    const c = seed()
    mount()
    edit(c.id)
    const before = { ...titleOf(c.id) }
    const tf = { ...clipOf(c.id).transform }
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByTestId('tiktok-style'))
      const t = titleOf(c.id)
      expect(t.text).toBe('two\nlines')
      expect(t.fontSizePx).toBe(before.fontSizePx)
      expect(t.offsetXPx).toBe(30)
      expect(t.offsetYPx).toBe(-40)
      expect(t.align).toBe(before.align)
      expect(t.vAlign).toBe(before.vAlign)
      expect(clipOf(c.id).transform).toEqual(tf)
    }
  })

  it('reads a title that is already highlighted as highlight, and soft as soft, and goes on from there', () => {
    const hl = titleLookById('tiktok-highlight')!.style
    const c = seed({ color: hl.color!, lineBox: hl.lineBox, shadow: undefined })
    mount()
    edit(c.id)
    const a = screen.getByTestId('tiktok-style')
    expect(a.getAttribute('data-style')).toBe('highlight')
    fireEvent.click(a)
    expect(a.getAttribute('data-style')).toBe('soft')
  })

  it('a click is its own undo step', () => {
    const c = seed()
    mount()
    edit(c.id)
    fireEvent.click(screen.getByTestId('tiktok-style'))
    expect(titleOf(c.id).lineBox).toBeDefined()
    useStore.getState().undo()
    expect(titleOf(c.id).lineBox).toBeUndefined()
  })
})

describe('the alignment button', () => {
  it('cycles left, centre, right on this title and keeps the rest', () => {
    const c = seed() // centred
    mount()
    edit(c.id)
    const b = screen.getByTestId('tiktok-align')
    expect(b.getAttribute('data-align')).toBe('center')
    fireEvent.click(b)
    expect(titleOf(c.id).align).toBe('right')
    fireEvent.click(b)
    expect(titleOf(c.id).align).toBe('left')
    fireEvent.click(b)
    expect(titleOf(c.id).align).toBe('center')
    expect(titleOf(c.id).text).toBe('two\nlines')
    expect(titleOf(c.id).offsetXPx).toBe(30)
  })
})

describe('the colour dots', () => {
  it('are the ten colours, white to pink, in a constant list', () => {
    expect(TIKTOK_DOTS.map((d) => d.id)).toEqual([
      'white', 'black', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink',
    ])
  })

  it('set the text colour when no highlight is on', () => {
    const c = seed()
    mount()
    edit(c.id)
    const red = TIKTOK_DOTS.find((d) => d.id === 'red')!
    fireEvent.click(screen.getByTestId('tiktok-dot-red'))
    expect(titleOf(c.id).color).toBe(red.color)
    expect(titleOf(c.id).lineBox).toBeUndefined()
  })

  it('set the highlight colour when a highlight is on, and flip the text colour so it reads', () => {
    const hl = titleLookById('tiktok-highlight')!.style
    const c = seed({ color: hl.color!, lineBox: hl.lineBox, shadow: undefined })
    mount()
    edit(c.id)
    const red = TIKTOK_DOTS.find((d) => d.id === 'red')!
    fireEvent.click(screen.getByTestId('tiktok-dot-red'))
    expect(titleOf(c.id).lineBox?.color).toBe(red.color)
    expect(titleOf(c.id).color).toBe(contrastTextColor(red.color))
    expect(titleOf(c.id).color).toBe('#ffffff')
    const yellow = TIKTOK_DOTS.find((d) => d.id === 'yellow')!
    fireEvent.click(screen.getByTestId('tiktok-dot-yellow'))
    expect(titleOf(c.id).lineBox?.color).toBe(yellow.color)
    expect(titleOf(c.id).color).toBe('#000000')
    // the highlight's own size and opacity stay
    expect(titleOf(c.id).lineBox?.padXEm).toBe(hl.lineBox!.padXEm)
    expect(titleOf(c.id).lineBox?.opacity).toBe(hl.lineBox!.opacity)
  })

  it('mark the colour the title wears now', () => {
    const c = seed()
    mount()
    edit(c.id)
    expect(screen.getByTestId('tiktok-dot-white').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('tiktok-dot-green'))
    expect(screen.getByTestId('tiktok-dot-green').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('tiktok-dot-white').getAttribute('aria-pressed')).toBe('false')
  })
})
