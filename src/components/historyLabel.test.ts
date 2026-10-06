// @vitest-environment jsdom
//
// What Undo and Redo say. "Undo: Set posX" was the code's name for the thing,
// and holding Ctrl+Z stacked a toast per step until the pile hit five.

import { beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from '../state/toasts'
import { historyLabel, showHistoryToast } from './historyLabel'

beforeEach(() => {
  useToasts.setState({ toasts: [] })
})

describe('historyLabel', () => {
  it('names a motion setting the way its row does', () => {
    expect(historyLabel('Set posX')).toBe('Set Position X')
    expect(historyLabel('Add cropT keyframe')).toBe('Add Crop Top keyframe')
    expect(historyLabel('Move scale keyframe')).toBe('Move Zoom keyframe')
  })

  it('names an effect setting the way its row does', () => {
    expect(historyLabel('Toggle exposure keyframes')).toBe('Toggle Exposure keyframes')
    expect(historyLabel('Set amount easing')).toBe('Set Amount easing')
  })

  it('leaves a label that is already in plain words alone', () => {
    for (const plain of ['Split at playhead', 'Add Blur', 'Remove effect', 'Remove 3 keyframes', 'Set speed', 'Rename project']) {
      expect(historyLabel(plain)).toBe(plain)
    }
  })
})

describe('the undo toast', () => {
  it('is one toast that updates in place, however many times he presses Ctrl+Z', () => {
    showHistoryToast('undo', 'Set posX')
    showHistoryToast('undo', 'Add cropT keyframe')
    showHistoryToast('redo', 'Add cropT keyframe')
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Redo: Add Crop Top keyframe'])
  })

  it('never takes another toast down with it', () => {
    useToasts.getState().show('Project saved', 'success')
    showHistoryToast('undo', 'Set posX')
    showHistoryToast('undo', 'Set posY')
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Project saved', 'Undo: Set Position Y'])
  })
})
