// @vitest-environment jsdom
//
// The wiring, not the verbs. `motionKeys.test.ts` proves what each keyframe verb
// DOES; this file proves the keys actually reach them.
//
// ⛔ THE FAILURE THIS EXISTS FOR IS A SILENT ONE. A combo that collides with an
// older binding loses to it without a word: `installKeymap` builds a Map keyed
// by combo, so the LAST one written wins and the other simply never runs. Five
// new combos went in on 2026-08-18 and nothing else in the app would have
// noticed one of them landing on a key that was already taken.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAppBindings } from './App'
import { installKeymap } from './keymap'
import { recomputeDuration } from '../src/engine/timeline'
import { channelKeyframes } from './engine/effects/channels'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from './engine/types'
import { addKeyframeAtPlayhead, toggleChannelAnimation } from './state/clipEdits'
import { cancelPicturePaste, installPasteListener, usePastePicture } from './state/picturePaste'
import { togglePlay } from './state/playbackControl'
import { updateActiveSequence, useStore } from './state/store'

vi.mock('./state/toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))
// Space's verb, watched rather than run: real playback needs a browser's audio.
vi.mock('./state/playbackControl', async (actual) => ({
  ...(await actual<typeof import('./state/playbackControl')>()),
  togglePlay: vi.fn(),
}))

const bindings = () => buildAppBindings()
const combos = () => bindings().map((b) => b.combo)
const firstClip = () => activeSequence(useStore.getState().project).tracks[0].clips[0]
const times = () => channelKeyframes(firstClip(), 'scale').map((k) => k.t)

function press(key: string, mods: { alt?: boolean; shift?: boolean; ctrl?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
      ctrlKey: mods.ctrl ?? false,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function seedPickedDiamonds(): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  useStore.getState().setUI({ playheadS: 1 })
  toggleChannelAnimation(clip.id, 'scale')
  useStore.getState().setUI({ playheadS: 3 })
  addKeyframeAtPlayhead(clip.id, 'scale')
  useStore.getState().setUI({
    selection: [clip.id],
    handTuneOpen: true,
    motionPicks: [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 3 },
    ],
    motionSelection: { channel: 'scale', kind: 'key', t: 1 },
  })
  return clip
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({
    selection: [],
    playheadS: 0,
    handTuneOpen: false,
    motionPicks: [],
    motionSelection: null,
    motionGroupDeltaS: null,
  })
})

describe('the central keymap', () => {
  // His ask, 2026-08-23: *"Let's make F5 a button that refreshes the app."*
  // Bound to the SAME action as the melon, which checks for an update first and
  // declines to reload on top of one it found.
  it('refreshes the app on F5', () => {
    expect(combos()).toContain('f5')
    const b = bindings().find((x) => x.combo === 'f5')
    expect(b?.description).toBe('Reload the app')
  })

  it('has no two bindings on the same combo', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const b of bindings()) {
      const prev = seen.get(b.combo)
      if (prev) clashes.push(`${b.combo}: "${prev}" and "${b.description}"`)
      seen.set(b.combo, b.description)
    }
    expect(clashes).toEqual([])
  })

  it('carries every key the motion keyboard needs', () => {
    for (const c of ['alt+[', 'alt+]', 'alt+a', 'alt+,', 'alt+.']) {
      expect(combos(), c).toContain(c)
    }
  })

  it('keeps the clip keys it shares with the diamonds', () => {
    for (const c of ['alt+arrowleft', 'shift+alt+arrowright', 'delete', 'mod+alt+c', 'mod+alt+v']) {
      expect(combos(), c).toContain(c)
    }
  })
})

describe('the keys reach the keyframe verbs', () => {
  it('Alt+Left nudges the picked diamonds, not the clip', () => {
    const clip = seedPickedDiamonds()
    const startS = firstClip().startS
    const uninstall = installKeymap(bindings())
    press('ArrowLeft', { alt: true })
    uninstall()
    const fps = activeSequence(useStore.getState().project).fps
    expect(times()[0]).toBeCloseTo(1 - 1 / fps, 6)
    // The clip itself must not have moved: one key, the selection it is aimed at.
    expect(firstClip().startS).toBe(startS)
    expect(firstClip().id).toBe(clip.id)
  })

  it('Alt+Left still nudges the CLIP when the hand controls are shut', () => {
    seedPickedDiamonds()
    useStore.getState().setUI({ handTuneOpen: false })
    const uninstall = installKeymap(bindings())
    press('ArrowLeft', { alt: true })
    uninstall()
    // Diamonds untouched: closed door, closed keyboard.
    expect(times()).toEqual([1, 3])
  })

  it('Delete drops the picked diamonds and keeps the clip', () => {
    seedPickedDiamonds()
    const uninstall = installKeymap(bindings())
    press('Delete')
    uninstall()
    expect(times()).toEqual([])
    expect(activeSequence(useStore.getState().project).tracks[0].clips).toHaveLength(1)
  })

  it('Alt+] walks the highlight to the next diamond', () => {
    seedPickedDiamonds()
    const uninstall = installKeymap(bindings())
    press(']', { alt: true })
    uninstall()
    expect(useStore.getState().ui.motionSelection?.t).toBe(3)
  })

  it('Alt+A adds a diamond in the middle of the selected segment', () => {
    seedPickedDiamonds()
    const uninstall = installKeymap(bindings())
    press('a', { alt: true })
    uninstall()
    expect(times()).toEqual([1, 2, 3])
  })

  it('Alt+. makes the picked move slower and Alt+, puts it back', () => {
    seedPickedDiamonds()
    const uninstall = installKeymap(bindings())
    press('.', { alt: true })
    const stretched = times()[1]
    press(',', { alt: true })
    uninstall()
    expect(stretched).toBeGreaterThan(3)
    expect(times()[1]).toBeCloseTo(3, 6)
  })

  it('Escape lets go of the diamonds before it lets go of the clip', () => {
    const clip = seedPickedDiamonds()
    const uninstall = installKeymap(bindings())
    press('Escape')
    expect(useStore.getState().ui.motionPicks).toEqual([])
    // The clip is still selected: one press, one thing let go of.
    expect(useStore.getState().ui.selection).toEqual([clip.id])
    press('Escape')
    uninstall()
    expect(useStore.getState().ui.selection).toEqual([])
  })
})

// 2026-10-06: with Projects open, Delete took the selected clip off the timeline behind it.
// A window or a menu over the edit holds the edit's keys until it closes.
describe('keys wait while a window or a menu is open over the edit', () => {
  const allClips = () => activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)

  function seedSelectedClip(): void {
    const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
      }),
    )
    useStore.getState().setUI({ selection: [clip.id], playheadS: 2 })
  }

  function over(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement('div')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    document.body.append(el)
    return el
  }

  for (const [what, attrs] of [
    ['a window', { role: 'dialog', 'aria-modal': 'true' }],
    ['a menu', { role: 'menu', 'data-esc-owner': '' }],
  ] as const) {
    it(`Delete, Backspace, C, M and Ctrl+Z do nothing behind ${what}`, () => {
      seedSelectedClip()
      const before = useStore.getState().project
      const el = over(attrs)
      const uninstall = installKeymap(bindings())
      try {
        press('Delete')
        press('Backspace')
        press('c')
        press('m')
        press('z', { ctrl: true })
        expect(useStore.getState().project).toBe(before)
        expect(allClips()).toHaveLength(1)
        // Closed, the same key works again.
        el.remove()
        press('Delete')
        expect(allClips()).toHaveLength(0)
      } finally {
        uninstall()
        el.remove()
      }
    })
  }

  it('a window that is not modal (the floating Record panel) holds nothing', () => {
    seedSelectedClip()
    const el = over({ role: 'dialog' })
    const uninstall = installKeymap(bindings())
    press('Delete')
    uninstall()
    el.remove()
    expect(allClips()).toHaveLength(0)
  })

  it('only Save and Reload still work over a window, because they do not touch the edit', () => {
    expect(bindings().filter((b) => b.overWindows).map((b) => b.combo).sort()).toEqual(['f5', 'mod+s'])
  })

  // 2026-10-07: Ctrl+V still got through. The keymap held the key, but the browser fired its paste
  // event anyway, and that pasted his copied clips at the playhead behind the window: in Captions,
  // "Paste a transcript", the clips went onto the timeline instead of his transcript into the box.
  function pasteOn(target: Element): Event {
    const e = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'so here we go' : ''), items: [] },
    })
    target.dispatchEvent(e)
    return e
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  for (const [what, attrs] of [
    ['a window', { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }],
    ['a menu', { role: 'menu', 'data-esc-owner': '' }],
  ] as const) {
    it(`Ctrl+V and its paste event paste no copied clip into the edit behind ${what}`, async () => {
      seedSelectedClip()
      const offKeys = installKeymap(bindings())
      const offPaste = installPasteListener()
      press('c', { ctrl: true })
      const before = useStore.getState().project
      const el = over(attrs)
      try {
        press('v', { ctrl: true })
        pasteOn(el)
        await settle()
        expect(useStore.getState().project).toBe(before)
        expect(allClips()).toHaveLength(1)
      } finally {
        offKeys()
        offPaste()
        el.remove()
      }
    })
  }

  it('a paste into a text box inside the window is left to the box', async () => {
    seedSelectedClip()
    const offKeys = installKeymap(bindings())
    const offPaste = installPasteListener()
    press('c', { ctrl: true })
    const before = useStore.getState().project
    const el = over({ role: 'dialog', 'aria-modal': 'true' })
    const box = document.createElement('textarea')
    el.append(box)
    box.focus()
    try {
      press('v', { ctrl: true })
      // Not taken: the browser's own paste puts the text in the box.
      expect(pasteOn(box).defaultPrevented).toBe(false)
      await settle()
      expect(useStore.getState().project).toBe(before)
    } finally {
      offKeys()
      offPaste()
      el.remove()
    }
  })
})

// 2026-10-06: after he clicked the clip volume slider, Right turned the volume up instead of
// stepping a frame, and Space did not play. A control he CLICKED gives the keys back to the edit;
// one he reached with Tab keeps them, and so does a text field.
describe('a clicked slider, tick box or select gives the keys back to the edit', () => {
  function seedClip(): void {
    const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
      }),
    )
    useStore.getState().setUI({ selection: [], playheadS: 1 })
  }

  function put<T extends HTMLElement>(html: string): T {
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    document.body.append(wrap)
    return wrap.firstElementChild as T
  }

  function click(el: HTMLElement): void {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    el.focus()
  }

  function pressOn(el: Element, key: string): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e
  }

  const fps = () => activeSequence(useStore.getState().project).fps
  const playhead = () => useStore.getState().ui.playheadS

  afterEach(() => {
    document.body.innerHTML = ''
  })

  for (const html of [
    '<input type="range" min="0" max="10" value="5">',
    '<input type="checkbox">',
    '<select><option>a</option><option>b</option></select>',
  ]) {
    it(`Right steps the playhead after a click on ${html.slice(0, 22)}`, () => {
      seedClip()
      const uninstall = installKeymap(bindings())
      try {
        const el = put<HTMLElement>(html)
        click(el)
        const e = pressOn(el, 'ArrowRight')
        // Taken by the edit, so the control itself does not move.
        expect(e.defaultPrevented).toBe(true)
        expect(playhead()).toBeCloseTo(1 + 1 / fps(), 6)
        // Space plays, and the browser does not tick the box or open the list.
        vi.mocked(togglePlay).mockClear()
        expect(pressOn(el, ' ').defaultPrevented).toBe(true)
        expect(togglePlay).toHaveBeenCalledTimes(1)
      } finally {
        uninstall()
      }
    })
  }

  it('a slider reached with Tab keeps its arrows', () => {
    seedClip()
    const uninstall = installKeymap(bindings())
    try {
      const el = put<HTMLInputElement>('<input type="range" min="0" max="10" value="5">')
      pressOn(document.body, 'Tab')
      el.focus()
      const e = pressOn(el, 'ArrowRight')
      expect(e.defaultPrevented).toBe(false)
      expect(playhead()).toBe(1)
    } finally {
      uninstall()
    }
  })

  // 2026-10-08: "clicked" outlived the click. He clicked the slider, then the timeline (which takes
  // no focus), and the slider he later reached with Tab still gave its arrows to the edit.
  it('a slider clicked, left for something that takes no focus, then reached with Tab keeps its arrows', async () => {
    seedClip()
    const uninstall = installKeymap(bindings())
    try {
      const el = put<HTMLInputElement>('<input type="range" min="0" max="10" value="5">')
      click(el)
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      el.blur()
      await new Promise((resolve) => setTimeout(resolve, 5))
      pressOn(document.body, 'Tab')
      el.focus()
      const e = pressOn(el, 'ArrowRight')
      expect(e.defaultPrevented).toBe(false)
      expect(playhead()).toBe(1)
    } finally {
      uninstall()
    }
  })

  it('a clicked slider stays clicked while the whole window loses the focus and gets it back', async () => {
    seedClip()
    const uninstall = installKeymap(bindings())
    try {
      const el = put<HTMLInputElement>('<input type="range" min="0" max="10" value="5">')
      click(el)
      // The window going to the background: a focusout naming nowhere, and the slider still focused.
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(pressOn(el, 'ArrowRight').defaultPrevented).toBe(true)
      expect(playhead()).toBeCloseTo(1 + 1 / fps(), 6)
    } finally {
      uninstall()
    }
  })

  // The other way round: a click on a slider that already has the focus fires no focusin, so one
  // reached with Tab and THEN clicked was never marked, and Right still turned the volume up.
  it('a slider reached with Tab and then clicked gives the keys back to the edit', () => {
    seedClip()
    const uninstall = installKeymap(bindings())
    try {
      const el = put<HTMLInputElement>('<input type="range" min="0" max="10" value="5">')
      pressOn(document.body, 'Tab')
      el.focus()
      el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      const e = pressOn(el, 'ArrowRight')
      expect(e.defaultPrevented).toBe(true)
      expect(playhead()).toBeCloseTo(1 + 1 / fps(), 6)
    } finally {
      uninstall()
    }
  })

  it('a text field keeps every key, clicked or not', () => {
    seedClip()
    const uninstall = installKeymap(bindings())
    try {
      const el = put<HTMLInputElement>('<input type="text">')
      click(el)
      vi.mocked(togglePlay).mockClear()
      expect(pressOn(el, 'ArrowRight').defaultPrevented).toBe(false)
      expect(pressOn(el, ' ').defaultPrevented).toBe(false)
      expect(playhead()).toBe(1)
      expect(togglePlay).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })
})

// 2026-10-08: the Czech AltGr fallback took every Ctrl+Alt for AltGr, so on a US keyboard Ctrl+Alt+1
// applied Move 1 to the selected clip, a key that had never done anything.
describe('Ctrl+Alt with a digit', () => {
  it('applies no Move, where the digit alone does', () => {
    const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
    )
    useStore.getState().setUI({ selection: [clip.id], playheadS: 1 })
    const digit = (mods: { ctrlKey?: boolean; altKey?: boolean }) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true, cancelable: true, ...mods }))
    const uninstall = installKeymap(bindings())
    try {
      const before = useStore.getState().project
      digit({ ctrlKey: true, altKey: true })
      expect(useStore.getState().project).toBe(before)
      digit({})
      expect(useStore.getState().project).not.toBe(before)
    } finally {
      uninstall()
    }
  })
})

// Ctrl+V after 2026-09-28. His words: *"Make it so I can just paste pictures"*.
// A copied picture only ever arrives on the browser's paste event, and the
// browser fires that event only when the keydown is left alone. So the key and
// the event both see every press, and the one thing that must never happen is
// both of them pasting.
describe('Ctrl+V pastes clips or a picture, once', () => {
  function pasteEvent(opts: { text?: string; files?: File[] } = {}): Event {
    const e = new Event('paste', { bubbles: true, cancelable: true })
    const items = (opts.files ?? []).map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }))
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? (opts.text ?? '') : ''), items },
    })
    return e
  }
  const allClips = () => activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  function seedCopiedClip(): void {
    const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
      }),
    )
    useStore.getState().setUI({ selection: [clip.id] })
  }

  it('leaves the keydown alone, so the browser still fires its paste event', async () => {
    const uninstall = installKeymap(bindings())
    const e = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    uninstall()
    // Its fallback paste runs here, not in the middle of the next test.
    await settle()
    expect(e.defaultPrevented).toBe(false)
  })

  it('one press with its paste event pastes the copied clip ONCE', async () => {
    seedCopiedClip()
    const offKeys = installKeymap(bindings())
    const offPaste = installPasteListener()
    press('c', { ctrl: true })
    press('v', { ctrl: true })
    window.dispatchEvent(pasteEvent({ text: 'OL Premiere: 1 clip copied' }))
    await settle()
    offKeys()
    offPaste()
    expect(allClips()).toHaveLength(2)
  })

  it('one press with no paste event still pastes the copied clip', async () => {
    seedCopiedClip()
    const offKeys = installKeymap(bindings())
    press('c', { ctrl: true })
    press('v', { ctrl: true })
    await settle()
    offKeys()
    expect(allClips()).toHaveLength(2)
  })

  it('a picture copied after the clips asks about the picture and pastes no clips', async () => {
    const createObjectURL = URL.createObjectURL
    const revokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:picture')
    URL.revokeObjectURL = vi.fn()
    try {
      seedCopiedClip()
      const offKeys = installKeymap(bindings())
      const offPaste = installPasteListener()
      press('c', { ctrl: true })
      press('v', { ctrl: true })
      const shot = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
      window.dispatchEvent(pasteEvent({ text: '', files: [shot] }))
      await settle()
      offKeys()
      offPaste()
      expect(usePastePicture.getState().picture?.file.type).toBe('image/png')
      expect(allClips()).toHaveLength(1)
    } finally {
      cancelPicturePaste()
      URL.createObjectURL = createObjectURL
      URL.revokeObjectURL = revokeObjectURL
    }
  })
})
