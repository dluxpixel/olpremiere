// Copy / Paste Attributes (Premiere's Cmd+Alt+C / Cmd+Alt+V): grab one clip's
// LOOK — its effect stack, transform, opacity, blend mode, mask, and (for a
// title) its style + animation — and stamp it onto every selected clip in one
// undo step. Faster than a saved preset when you just want "make these look
// like that one".

import { applyAppearanceToClip } from '../engine/anim/appearance'
import {
  activeSequence,
  newId,
  type AppearanceSpec,
  type Clip,
  type EffectInstance,
  type TitleDef,
} from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

interface ClipAttrs {
  effects: EffectInstance[]
  transform: Clip['transform']
  opacity: number
  blendMode: Clip['blendMode']
  /** undefined = the source had no mask; pasting CLEARS the target's. */
  mask: Clip['mask']
  /** Title style (everything but the text) — only for title clips. */
  title?: Partial<TitleDef>
  appearance?: AppearanceSpec
}

let clipboard: ClipAttrs | null = null

export function hasClipAttributes(): boolean {
  return clipboard !== null
}

/** Copy the attributes of a clip (defaults to the first selected clip). */
export function copyClipAttributes(clipId?: string): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const id = clipId ?? s.ui.selection[0]
  const clip = id ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id) : undefined
  if (!clip) {
    useToasts.getState().show('Select a clip to copy attributes from', 'danger')
    return
  }
  const t = clip.title
  clipboard = {
    effects: clip.effects,
    transform: clip.transform,
    opacity: clip.opacity,
    blendMode: clip.blendMode,
    mask: clip.mask ? structuredClone(clip.mask) : undefined,
    appearance: clip.appearance,
    title: t
      ? {
          fontFamily: t.fontFamily,
          fontSizePx: t.fontSizePx,
          bold: t.bold,
          italic: t.italic,
          textCase: t.textCase,
          color: t.color,
          align: t.align,
          vAlign: t.vAlign,
          outline: t.outline,
          shadow: t.shadow,
          box: t.box,
          offsetXPx: t.offsetXPx,
          offsetYPx: t.offsetYPx,
        }
      : undefined,
  }
  useToasts.getState().show('Attributes copied — paste onto other clips')
}

/** Deep-clone an effect stack with fresh instance ids (so each clip owns its copy). */
function cloneEffects(effects: readonly EffectInstance[]): EffectInstance[] {
  return effects.map((e) => ({ ...structuredClone(e), id: newId() }))
}

/** Paste the copied attributes onto every selected clip (or `ids`) — one undo step. */
export function pasteClipAttributes(ids?: Iterable<string>): void {
  const attrs = clipboard
  if (!attrs) {
    useToasts.getState().show('Nothing to paste — copy attributes first', 'danger')
    return
  }
  const idSet = new Set(ids ?? useStore.getState().ui.selection)
  if (idSet.size === 0) {
    useToasts.getState().show('Select clip(s) to paste onto', 'danger')
    return
  }
  let pasted = 0
  updateActiveSequence('Paste attributes', (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id)) return c
        changed = true
        pasted++
        let nc: Clip = {
          ...c,
          effects: cloneEffects(attrs.effects),
          transform: attrs.transform,
          opacity: attrs.opacity,
          blendMode: attrs.blendMode ?? 'normal',
          // Clone per target so pasted clips never share one mask object.
          mask: attrs.mask ? structuredClone(attrs.mask) : undefined,
        }
        // Titles also inherit the style (never the text) + animation.
        if (c.title && attrs.title) nc = { ...nc, title: { ...c.title, ...attrs.title } }
        // Always recompile: a source with NO animation must CLEAR the target's
        // (an empty spec deletes the appearance channels), or leftover keyframes
        // would override the pasted static transform.
        nc = applyAppearanceToClip(nc, attrs.appearance ?? {}, seq.width, seq.height)
        return nc
      })
      return { ...t, clips }
    })
    return changed ? { ...seq, tracks } : seq
  })
  if (pasted > 0) useToasts.getState().show(`Attributes pasted to ${pasted} clip(s)`)
  else useToasts.getState().show('Those clips are on a locked track', 'danger')
}
