// @vitest-environment jsdom
//
// A new title in TikTok text mode: the TikTok look, at the middle of the SAFE area, and straight
// into typing on the video. Out of the mode it is exactly what it always was.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

import { appGuideRegions } from '../engine/appGuides'
import { activeSequence, defaultTitleDef, newProject, type Clip } from '../engine/types'
import { useTextEdit, endTextEdit } from '../components/MonitorTextEdit'
import { setTiktokMode } from './settings'
import { useStore } from './store'
import { titleLookById } from './titleShelf'
import { addTitleClip, addTitleFromShelf } from './titleActions'

const titles = (): Clip[] =>
  activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .filter((c) => c.title)

beforeEach(() => {
  localStorage.clear()
  setTiktokMode(false)
  endTextEdit()
  useStore.getState().setProject(newProject('p', { w: 1080, h: 1920 }))
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
})

describe('a new title with TikTok text mode on', () => {
  it('wears the tiktok-plain look, keeping the look the shelf has', () => {
    setTiktokMode(true)
    addTitleClip()
    const t = titles()[0]!.title!
    const look = titleLookById('tiktok-plain')!
    expect(t.fontFamily).toBe(look.style.fontFamily)
    expect(t.fontSizePx).toBe(64)
    expect(t.color).toBe('#ffffff')
    expect(t.shadow).toEqual(look.style.shadow)
    expect(t.lineBox).toBeUndefined()
  })

  it('sits at the centre of the safe area, not the frame centre', () => {
    setTiktokMode(true)
    addTitleClip()
    const c = titles()[0]!
    const r = appGuideRegions(1080, 1920, 'tiktok')!
    const top = r.find((x) => x.key === 'top')!.h
    const bottom = r.find((x) => x.key === 'bottom')!.h
    const right = r.find((x) => x.key === 'right')!.w
    // safe x 0..950, y 150..1480: centre (475, 815), against the frame's (540, 960)
    expect(c.transform.x).toBe((1080 - right) / 2 - 540)
    expect(c.transform.y).toBe((top + (1920 - bottom)) / 2 - 960)
    expect(c.transform.x).toBe(-65)
    expect(c.transform.y).toBe(-145)
  })

  it('starts empty, is selected, and goes straight into typing on the video', () => {
    setTiktokMode(true)
    addTitleClip()
    const c = titles()[0]!
    expect(c.title!.text).toBe('')
    expect(useStore.getState().ui.selection).toEqual([c.id])
    expect(useTextEdit.getState().editing?.clipId).toBe(c.id)
  })

  it('keeps words he passes in', () => {
    setTiktokMode(true)
    addTitleClip('Round 2')
    expect(titles()[0]!.title!.text).toBe('Round 2')
  })

  it('does not start typing while the video plays, where there is no field to type in', () => {
    setTiktokMode(true)
    useStore.getState().setUI({ playing: true })
    addTitleClip()
    expect(useTextEdit.getState().editing).toBeNull()
  })

  it('on a wide frame the safe area is the whole frame, so the title stays in the middle', () => {
    setTiktokMode(true)
    useStore.getState().setProject(newProject('p', { w: 1920, h: 1080 }))
    addTitleClip()
    const c = titles()[0]!
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
  })

  it('a title off the shelf keeps the look he picked, where it is dropped, and does not start typing', () => {
    setTiktokMode(true)
    addTitleFromShelf('headline-pop')
    const c = titles()[0]!
    expect(c.title!.fontSizePx).toBe(120)
    expect(c.title!.text).toBe('Your headline')
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
    expect(useTextEdit.getState().editing).toBeNull()
  })
})

describe('a new title with the mode off', () => {
  it('is exactly the old default title: plain look, frame centre, no typing', () => {
    addTitleClip()
    const c = titles()[0]!
    expect(c.title).toEqual(defaultTitleDef('Title'))
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
    expect(useTextEdit.getState().editing).toBeNull()
    expect(useStore.getState().ui.selection).toEqual([c.id])
  })
})
