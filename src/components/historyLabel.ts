// What Undo and Redo say, in the words the panels use.
//
// The labels on the undo stack are built from internal names: "Set posX", "Add
// cropT keyframe", "Toggle exposure keyframes". The toast and the Undo button's
// tooltip printed them as they were. This maps them for DISPLAY ONLY: the
// stored labels stay as they are, so the usage log and its report keep the same
// names from one day to the next.

import { EFFECTS } from '../engine/effects/registry'
import { ANIM_CHANNELS, type AnimChannel } from '../engine/types'
import { useToasts } from '../state/toasts'
import { friendly } from './keyframeMarks'

const CHANNELS: ReadonlySet<string> = new Set(ANIM_CHANNELS)

/** An effect setting's name as its row shows it. The first effect to use a key names it. */
const PARAM_NAMES = new Map<string, string>()
for (const effect of EFFECTS) {
  for (const param of effect.params) if (!PARAM_NAMES.has(param.key)) PARAM_NAMES.set(param.key, param.label)
}

/** The label shapes that carry an internal name: `Set posX`, `Add cropT keyframe`, `Set amount easing`. */
const NAMED = /^(Set|Add|Remove|Move|Toggle) (\S+)( keyframes?| easing)?$/

export function historyLabel(label: string): string {
  const m = NAMED.exec(label)
  if (!m) return label
  const key = m[2]
  const name = CHANNELS.has(key) ? friendly(key as AnimChannel) : PARAM_NAMES.get(key)
  return name ? `${m[1]} ${name}${m[3] ?? ''}` : label
}

/**
 * The toast after Ctrl+Z, Ctrl+Y or the Undo and Redo buttons. ONE toast that
 * updates in place: holding Ctrl+Z used to stack a new one per step until the
 * pile hit its cap of five.
 */
export function showHistoryToast(dir: 'undo' | 'redo', label: string): void {
  useToasts
    .getState()
    .show(`${dir === 'undo' ? 'Undo' : 'Redo'}: ${historyLabel(label)}`, 'info', undefined, { replaceKey: 'history' })
}
