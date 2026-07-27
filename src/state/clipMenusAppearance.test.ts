import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type MediaAsset,
} from '../engine/types'
import { appearanceMenuItems } from './clipMenus'
import { useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const videoAsset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const imageAsset: MediaAsset = { id: 'i', name: 'i', kind: 'image', blobKey: 'b', durationS: 0, hasAudio: false, hasVideo: false }

const addAsset = (a: MediaAsset) =>
  useStore.setState((s) => ({ project: { ...s.project, assets: { ...s.project.assets, [a.id]: a } } }))

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('appearanceMenuItems: entrances by clip kind', () => {
  it('shows entrance/exit for a TITLE clip', () => {
    const clip = newTitleClip(defaultTitleDef('hi'), 0, 3)
    expect(appearanceMenuItems(clip).some((i) => i.label?.startsWith('Entrance'))).toBe(true)
  })

  it('shows entrance/exit for a still IMAGE clip (it "appears" like text)', () => {
    addAsset(imageAsset)
    const clip = newClipFromAsset(imageAsset, 0)
    expect(appearanceMenuItems(clip).some((i) => i.label?.startsWith('Entrance'))).toBe(true)
  })

  it('is EMPTY for a VIDEO clip (video animates via Motion + transitions)', () => {
    addAsset(videoAsset)
    const clip = newClipFromAsset(videoAsset, 0)
    expect(appearanceMenuItems(clip)).toEqual([])
  })
})
