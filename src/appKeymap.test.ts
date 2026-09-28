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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAppBindings } from './App'
import { installKeymap } from './keymap'
import { recomputeDuration } from '../src/engine/timeline'
import { channelKeyframes } from './engine/effects/channels'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from './engine/types'
import { addKeyframeAtPlayhead, toggleChannelAnimation } from './state/clipEdits'
import { cancelPicturePaste, installPasteListener, usePastePicture } from './state/picturePaste'
import { updateActiveSequence, useStore } from './state/store'

vi.mock('./state/toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

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
