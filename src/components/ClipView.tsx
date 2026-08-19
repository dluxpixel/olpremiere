import { Link2 } from 'lucide-react'
import { memo, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { clipDurationS } from '../engine/timeline'
import { clipKeyframeTimes } from '../engine/keyframes'
import { type TransitionKind } from '../engine/render/types'
import { transitionMarkPx } from '../engine/transitionMarks'
import { applyEffect, moveClipKeyframe, setClipTransition } from '../state/clipEdits'
import { EFFECT_MIME, TRANSITION_MIME, dragHasType, edgeForOffset } from '../state/dnd'
import { type Clip, type Id, type MediaAsset } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { useFilmstrip } from '../state/filmstrips'
import { ClipWaveform } from './ClipWaveform'
import { useStore } from '../state/store'

// ---------------------------------------------------------------------------
// Clip

function familyFor(asset: MediaAsset | undefined): { bg: string; bd: string } {
  if (!asset) return { bg: 'var(--color-bg-input)', bd: 'var(--color-border-strong)' }
  if (asset.kind === 'audio') return { bg: 'var(--color-clip-audio)', bd: 'var(--color-clip-audio-bd)' }
  if (asset.kind === 'image') return { bg: 'var(--color-clip-image)', bd: 'var(--color-clip-image-bd)' }
  return { bg: 'var(--color-clip-video)', bd: 'var(--color-clip-video-bd)' }
}

interface ClipViewProps {
  clip: Clip
  asset: MediaAsset | undefined
  trackKind: 'video' | 'audio'
  trackHeight: number
  pxPerS: number
  selected: boolean
  /** Locked tracks reject every mutation, including effect/transition drops. */
  locked: boolean
  /**
   * False when a non-select tool is active or the track is locked: the trim
   * zones and fade dots hide, so the cursor never advertises a gesture the
   * pointer-down handlers would refuse. Also lets razor/hand presses land on
   * the clip itself instead of being swallowed by an edge handle.
   */
  interactive: boolean
  /** One-shot accent pulse for a genuinely NEW clip. With virtualization a
   *  mount can also be a scroll-in, so newness is decided by the parent. */
  pop: boolean
  /**
   * Real transition seconds at each edge, from engine/transitionMarks. Passed
   * as numbers rather than the neighbour clips so this memo() still skips a
   * render when a neighbour moves without changing what crosses the cut.
   */
  transitionHeadS: number
  transitionTailS: number
  onClipPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void
  onTrimPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'in' | 'out') => void
  onClipContextMenu: (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => void
  onFadeCommit: (clipId: Id, edge: 'in' | 'out', seconds: number) => void
  /** Live tooltip while dragging a fade handle (null clears it). */
  onFadePreview: (tip: { x: number; y: number; text: string } | null) => void
}

// Memoized: during a drag, previewSeq re-renders the lane tree every
// pointermove, but the engine preserves object identity for untouched clips -
// so with stable handler props, every clip NOT being dragged skips its render
// (filmstrip, waveform, fades and all). This is the big drag-feel win on
// caption-heavy timelines.
export const ClipView = memo(function ClipView({
  clip,
  asset,
  trackKind,
  trackHeight,
  pxPerS,
  selected,
  locked,
  interactive,
  pop,
  transitionHeadS,
  transitionTailS,
  onClipPointerDown,
  onTrimPointerDown,
  onClipContextMenu,
  onFadeCommit,
  onFadePreview,
}: ClipViewProps) {
  const left = clip.startS * pxPerS
  const durS = clipDurationS(clip)
  const width = Math.max(4, durS * pxPerS)
  const innerH = Math.max(1, trackHeight - 6)
  // Titles are generated (no asset): a distinct violet family + the text label.
  const isTitle = clip.title !== undefined
  const isAdjustment = clip.adjustment === true
  const isAudio = !isTitle && !isAdjustment && trackKind === 'audio'
  // Colour by the TRACK: an audio-track clip is audio-family even when it
  // references a video asset (a linked-audio split).
  const { bg, bd } = isTitle
    ? { bg: 'var(--color-clip-title)', bd: 'var(--color-clip-title-bd)' }
    : isAdjustment
      ? { bg: 'var(--color-accent-quiet)', bd: 'var(--color-accent)' }
      : trackKind === 'audio'
        ? { bg: 'var(--color-clip-audio)', bd: 'var(--color-clip-audio-bd)' }
        : familyFor(asset)
  const kind = isTitle ? 'title' : isAdjustment ? 'adjustment' : trackKind
  // The clip label mirrors the rendered case (textCase) so a lowercase/UPPERCASE
  // toggle visibly updates the timeline chip too, not just the preview.
  const titleText = isTitle
    ? clip.title!.textCase === 'upper'
      ? (clip.title!.text || 'Title').toUpperCase()
      : clip.title!.textCase === 'lower'
        ? (clip.title!.text || 'Title').toLowerCase()
        : clip.title!.text || 'Title'
    : ''
  const label = isTitle ? titleText : isAdjustment ? 'Adjustment' : (asset?.name ?? 'Missing media')
  const thumb = useBlobUrl(isTitle || isAdjustment || trackKind === 'audio' ? undefined : asset?.thumbnailKey)
  // Filmstrip across the whole clip (real NLE look); the single poster frame
  // stays as the instant placeholder while a strip generates.
  const strip = useFilmstrip(
    isTitle || trackKind === 'audio' ? undefined : asset,
    width,
    clip.inS,
    clip.outS,
    clip.speed,
  )

  // Fade drag: dragRef holds the gesture; fadePreview drives the live overlay.
  // The committed value is computed purely from the pointer + dragRef on release
  // (no stale state, no StrictMode double-commit).
  const fadeDragRef = useRef<{ edge: 'in' | 'out'; startX: number; startVal: number } | null>(null)
  const [fadePreview, setFadePreview] = useState<{ edge: 'in' | 'out'; val: number } | null>(null)
  const fadeInS = fadePreview?.edge === 'in' ? fadePreview.val : clip.fadeInS
  const fadeOutS = fadePreview?.edge === 'out' ? fadePreview.val : clip.fadeOutS

  const valFor = (d: { edge: 'in' | 'out'; startX: number; startVal: number }, clientX: number): number => {
    const delta = (clientX - d.startX) / pxPerS
    const raw = d.edge === 'in' ? d.startVal + delta : d.startVal - delta
    return Math.max(0, Math.min(durS, raw))
  }
  const beginFade = (e: ReactPointerEvent<HTMLDivElement>, edge: 'in' | 'out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startVal = edge === 'in' ? clip.fadeInS : clip.fadeOutS
    fadeDragRef.current = { edge, startX: e.clientX, startVal }
    setFadePreview({ edge, val: startVal })
  }
  const moveFade = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = fadeDragRef.current
    if (!d) return
    const val = valFor(d, e.clientX)
    setFadePreview({ edge: d.edge, val })
    onFadePreview({ x: e.clientX, y: e.clientY - 34, text: `Fade ${d.edge} ${val.toFixed(2)}s` })
  }
  const endFade = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = fadeDragRef.current
    fadeDragRef.current = null
    setFadePreview(null)
    onFadePreview(null)
    if (!d) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const val = valFor(d, e.clientX)
    if (Math.abs(val - d.startVal) > 1e-4) onFadeCommit(clip.id, d.edge, val)
  }

  const fadeInPx = fadeInS * pxPerS
  const fadeOutPx = fadeOutS * pxPerS

  // How wide the grab zone at each end is. Hoisted out of the two trim zones
  // below because the fade dots have to know it: they are round, they are
  // centred on their value, and at a fade of zero that puts half a dot on top
  // of this exact strip.
  const trimPx = width < 24 ? Math.max(3, Math.floor(width / 4)) : 6

  /**
   * Half a fade dot. `w-2.5` is 10px and `-translate-x-1/2` centres it on its
   * value, so a dot parked at `left: trimPx` still has HALF of itself under the
   * strip, and its middle sits exactly on the strip's edge.
   *
   * ⛔ PARKING AT `trimPx` WAS NOT ENOUGH AND THE BROWSER GATE IS WHAT SAID SO.
   * The fix on 2026-08-18 moved the dot to `trimPx` and gave the strip z-20, so
   * the only grabbable part of a zero fade was the 5px between the strip's edge
   * and the dot's right edge. `phase6.spec.ts` pressing 1px in went to the trim,
   * exactly as it had before, and the fade still could not be started there.
   * Adding the radius is what actually clears it: the dot now begins where the
   * strip ends and the whole 10px of it is his to grab.
   */
  const dotR = 5

  // Keyframes, drawn ON the clip the way CapCut does. Until now they existed
  // only inside the Inspector's 240px lane, so nothing on the timeline said a
  // clip was animated at all, let alone WHERE. Clip-local seconds map straight
  // to px at the current zoom.
  // Depends on exactly the two fields keyframes can live in; taking the whole
  // clip would recompute on every move, trim and rename.
  //
  // ONE MARK PER MOMENT, and that survives the lanes: a lasso in the motion
  // rail can now slide one channel off a moment two others still sit on, and
  // when it does clipKeyframeTimes returns two times where it returned one, so
  // the strip draws two diamonds. The read stays true because it was never a
  // per-channel read. What the mark could NOT keep saying is that a drag
  // retimes "this keyframe": moveKeyframeMoment takes every channel at that
  // instant with it, which was invisible while every channel shared every
  // moment and is a different edit now that they need not. The title says so.
  //
  // Residual, deliberately not papered over here: two moments closer together
  // than a diamond is wide (one frame is ~2px at the default 60px/s) overlap,
  // and the later one takes the pointer. Zooming the strip in separates them,
  // and the motion rail is the surface built to zoom; adding a merge here would
  // mean a drag that silently retimed one of the two it stands for.
  const { keyframes: clipKfs, effects: clipFx } = clip
  const keyframeTimes = useMemo(
    () => clipKeyframeTimes({ keyframes: clipKfs, effects: clipFx }),
    [clipKfs, clipFx],
  )

  // Dragging a diamond retimes the whole MOMENT. Live position is local state so
  // the drag is smooth; the commit is a single undo step on release, the same
  // shape the fade handles use.
  const kfDragRef = useRef<{ fromT: number; startX: number } | null>(null)
  const [kfPreview, setKfPreview] = useState<{ fromT: number; t: number } | null>(null)
  const beginKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>, t: number) => {
    if (e.button !== 0 || locked) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    kfDragRef.current = { fromT: t, startX: e.clientX }
    setKfPreview({ fromT: t, t })
  }
  // Takes the gesture explicitly rather than reading the ref: the commit path
  // clears the ref first, so reading it there silently produced t=0 and every
  // drag landed on the clip's head.
  const kfTimeAt = (d: { fromT: number; startX: number }, clientX: number): number =>
    Math.max(0, Math.min(durS, d.fromT + (clientX - d.startX) / pxPerS))
  const moveKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = kfDragRef.current
    if (!d) return
    setKfPreview({ fromT: d.fromT, t: kfTimeAt(d, e.clientX) })
  }
  const endKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = kfDragRef.current
    kfDragRef.current = null
    setKfPreview(null)
    if (!d) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const t = kfTimeAt(d, e.clientX)
    if (Math.abs(t - d.fromT) > 1e-4) moveClipKeyframe(clip.id, d.fromT, t)
  }

  // A transition's mark can never be wider than the clip it sits on, or two
  // long ones on a short clip would draw past each other.
  const { headPx: transitionInPx, tailPx: transitionOutPx } = transitionMarkPx(
    { headS: transitionHeadS, tailS: transitionTailS },
    pxPerS,
    width,
  )

  // Effect / transition drops land on the clip itself. A transition takes the
  // edge nearest the cursor; `fxDropEdge` previews which one while hovering.
  const [fxDropEdge, setFxDropEdge] = useState<'in' | 'out' | null>(null)
  const [fxDropHot, setFxDropHot] = useState(false)

  // offsetX is relative to whatever CHILD is under the cursor (waveform, label,
  // fade handle), not the clip. Measure against the clip's own box instead.
  const offsetInClip = (e: DragEvent<HTMLDivElement>): number =>
    e.clientX - e.currentTarget.getBoundingClientRect().left

  const fxDragOver = (e: DragEvent<HTMLDivElement>) => {
    // A locked track rejects grades exactly like it rejects trims and moves.
    // (Found in review: this was the ONE mutation path that ignored the lock.)
    if (locked) return
    const t = e.dataTransfer.types
    const isEffect = dragHasType(t, EFFECT_MIME)
    const isTransition = dragHasType(t, TRANSITION_MIME)
    if (!isEffect && !isTransition) return
    // Neither effects nor transitions composite on audio (resolveFrame skips
    // audio tracks entirely), so either one dropped there would render nothing.
    // Refuse both here so the cursor shows "no-drop" instead of accepting
    // something dead.
    if (isAudio) return
    // Beat the track-level asset drop handler to the event.
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setFxDropHot(true)
    setFxDropEdge(isTransition ? edgeForOffset(offsetInClip(e), width) : null)
  }

  const clearFxDrop = () => {
    setFxDropHot(false)
    setFxDropEdge(null)
  }

  // dragleave also fires when the cursor crosses between a clip's own children,
  // which would flicker the hint. Only clear when it truly leaves the clip.
  const fxDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && e.currentTarget.contains(to)) return
    clearFxDrop()
  }

  const fxDrop = (e: DragEvent<HTMLDivElement>) => {
    if (locked) return
    const effectType = e.dataTransfer.getData(EFFECT_MIME)
    const transitionKind = e.dataTransfer.getData(TRANSITION_MIME)
    if (!effectType && !transitionKind) return
    // Neither composites on audio: a transition is a shader blending two
    // PICTURES, so dropping one on an audio clip wrote a field the renderer
    // never reads and drew a mark for a transition that could not happen. Audio
    // has its own verb: "Crossfade with previous" in the clip menu.
    if (isAudio) return
    e.preventDefault()
    e.stopPropagation()
    clearFxDrop()
    if (effectType) applyEffect(clip.id, effectType)
    else setClipTransition(clip.id, edgeForOffset(offsetInClip(e), width), transitionKind as TransitionKind)
    // Reveal what just happened in the Inspector.
    useStore.getState().setUI({ selection: [clip.id] })
  }

  return (
    <div
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-kind={kind}
      // A frozen clip looks exactly like a running one, and a hold you cannot
      // see is a hold you forget you left on. The snowflake says it.
      data-frozen={clip.freezeAtS !== undefined ? 'true' : undefined}
      // A one-shot accent pulse for a genuinely new clip (add / paste / undo-
      // restore). Mount is NOT meaningful anymore - virtualization remounts
      // clips as they scroll in - so the parent decides newness by id.
      // Family look: flat fill, a dark hairline seam (so butted cuts stay
      // visible), and a brighter 1px TOP edge in the family color. Selection
      // is a 2px lavender ring plus a slight lift in fill luminance.
      className={`group/clip absolute bottom-[3px] top-[3px] ${pop ? 'animate-[clip-pop_500ms_ease-out]' : ''} overflow-hidden rounded-clip border border-black/40 ${
        // Selection lifts the clip (offset ring + brightness); an imminent FX
        // drop is an INSET ring - the two states must never look alike.
        selected ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-app brightness-110' : ''
      } ${clip.enabled ? '' : 'opacity-40'} ${fxDropHot ? 'ring-2 ring-inset ring-accent-hover' : ''}`}
      style={{ left, width, background: bg, borderTopColor: bd }}
      onPointerDown={(e) => onClipPointerDown(e, clip)}
      onContextMenu={(e) => onClipContextMenu(e, clip)}
      onDragOver={fxDragOver}
      onDragLeave={fxDragLeave}
      onDrop={fxDrop}
    >
      {fxDropEdge && (
        <div
          data-testid="transition-drop-hint"
          className={`pointer-events-none absolute inset-y-0 w-1/2 bg-accent/25 ${fxDropEdge === 'in' ? 'left-0' : 'right-0'}`}
        />
      )}
      {clip.freezeAtS !== undefined && (
        <span
          data-testid="clip-frozen-badge"
          className="pointer-events-none absolute left-1 top-1 rounded-[3px] bg-black/45 px-1 text-[10px] leading-[14px] text-white/85"
          title="This clip is holding one frame. Press F to let it run again."
        >
          ❄
        </span>
      )}
      {isAudio && asset && <ClipWaveform clip={clip} asset={asset} width={width} height={innerH} />}
      {clip.linkId && (
        <span
          className="pointer-events-none absolute bottom-1 right-1 rounded-[3px] bg-black/45 p-0.5 text-white/80"
          title="Linked A/V"
        >
          <Link2 size={9} strokeWidth={2} />
        </span>
      )}
      {strip && width > 48 ? (
        <img
          src={strip}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-80"
        />
      ) : (
        thumb &&
        width > 48 && (
          <img
            src={thumb}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-y-0 left-0 h-full w-auto object-cover opacity-80"
          />
        )
      )}
      {/* Solid name strip, only over imagery: a text-shadow alone can't hold
          11px text over bright frames, and flat family fills must stay flat
          (no gradients anywhere).
          ⛔ A WAVEFORM IS IMAGERY TOO, and it was excluded until 2026-08-18.
          Audio tracks force both `strip` and `thumb` to undefined (lines 110
          and 113), so audio was exactly the case this test could never be true
          for, and the white name sat straight on the bars at about 2.1:1 with
          full-scale peaks running through the letters. The rule above was right
          and the condition under it named the wrong thing. Flat fills (titles,
          adjustments, audio with nothing decoded yet) still get no strip. */}
      {width > 48 && (strip || thumb || (isAudio && asset)) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[15px] bg-black/45" />
      )}
      <span className="pointer-events-none absolute left-1.5 right-1.5 top-0.5 truncate text-[11px] font-medium text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
        {label}
      </span>

      {/* z-20: the trim zones are later siblings with no stacking of their own,
          so without it the FIRST diamond sits UNDER the trim-in handle and
          dragging it silently trims the clip's head instead of retiming. */}
      {keyframeTimes.length > 0 && width > 8 && (
        <div data-testid="clip-keyframes" className="absolute inset-x-0 bottom-0 z-20 h-3">
          {keyframeTimes.map((t, i) => {
            const live = kfPreview?.fromT === t ? kfPreview.t : t
            const raw = live * pxPerS
            if (raw < -3 || raw > width + 3) return null
            // Keep the WHOLE diamond inside the clip. It is a 7px square rotated
            // 45°, so it reaches ~5px either side of its centre. A keyframe at
            // the very start or end was drawn half outside and the clip's own
            // edge cut it in half, which reads as a rendering glitch rather than
            // as a keyframe. Showing all of it 5px in is more honest than showing
            // half of it in the right place: the mark means "there is a keyframe
            // at this edge", and half a mark says nothing.
            const HALF = 5
            const x = width >= HALF * 2 ? Math.min(Math.max(raw, HALF), width - HALF) : raw
            return (
              <span
                key={i}
                data-testid="clip-keyframe"
                title="Drag to retime every keyframe at this moment"
                className={`absolute bottom-[3px] h-[7px] w-[7px] -translate-x-1/2 rotate-45 border border-black/50 ${
                  kfPreview?.fromT === t ? 'bg-accent' : 'bg-white/90'
                } ${interactive && !locked ? 'cursor-ew-resize' : 'pointer-events-none'}`}
                style={{ left: x }}
                onPointerDown={(e) => beginKeyframeDrag(e, t)}
                onPointerMove={moveKeyframeDrag}
                onPointerUp={endKeyframeDrag}
                onPointerCancel={endKeyframeDrag}
              />
            )
          })}
        </div>
      )}

      {/* Transitions were INVISIBLE on the timeline: nothing read transitionIn/
          Out, so there was no way to see which cuts already had one, or which
          kind. A bowtie at the edge, the width of the transition, is the NLE
          convention and costs no extra hit area (it never takes pointers).
          Both HALVES are drawn now: a pair transition is stored on one clip but
          plays across the cut, so the clip on the other side used to show
          nothing at all. The widths come from engine/transitionMarks, which
          reads the renderer's own window, so each side reports what really
          happens to it and not the raw durationS the user typed. */}
      {(transitionInPx > 0.5 || transitionOutPx > 0.5) && (
        <svg
          data-testid="transition-overlay"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={innerH}
          preserveAspectRatio="none"
        >
          {transitionInPx > 0.5 && (
            <g data-testid="transition-in-mark">
              <rect x={0} y={0} width={transitionInPx} height={innerH} fill="rgba(255,255,255,0.14)" />
              <path
                d={`M0,0 L${transitionInPx},${innerH} M0,${innerH} L${transitionInPx},0`}
                stroke="rgba(255,255,255,0.7)"
                strokeWidth={1}
                fill="none"
              />
            </g>
          )}
          {transitionOutPx > 0.5 && (
            <g data-testid="transition-out-mark">
              <rect
                x={width - transitionOutPx}
                y={0}
                width={transitionOutPx}
                height={innerH}
                fill="rgba(255,255,255,0.14)"
              />
              <path
                d={`M${width - transitionOutPx},0 L${width},${innerH} M${width - transitionOutPx},${innerH} L${width},0`}
                stroke="rgba(255,255,255,0.7)"
                strokeWidth={1}
                fill="none"
              />
            </g>
          )}
        </svg>
      )}

      {(fadeInPx > 0.5 || fadeOutPx > 0.5) && (
        <svg
          data-testid="fade-overlay"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={innerH}
          preserveAspectRatio="none"
        >
          {fadeInPx > 0.5 && (
            <>
              <path d={`M0,0 L${fadeInPx},0 L0,${innerH} Z`} fill="rgba(0,0,0,0.4)" />
              <line x1={0} y1={innerH} x2={fadeInPx} y2={0} stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
            </>
          )}
          {fadeOutPx > 0.5 && (
            <>
              <path d={`M${width},0 L${width - fadeOutPx},0 L${width},${innerH} Z`} fill="rgba(0,0,0,0.4)" />
              <line x1={width - fadeOutPx} y1={0} x2={width} y2={innerH} stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
            </>
          )}
        </svg>
      )}

      {/* Fade dots share the clip's corners with the trim zones - on narrow
          clips they'd fight for the same pixels, so they step aside.
          ⛔ AND THEY STEP ASIDE ON WIDE ONES TOO, since 2026-08-18, because A
          FADE COULD NOT BE STARTED AT ALL. The dot is 10px and centred on its
          value, so at a fade of zero it sat on x 0..5, entirely inside the 6px
          trim strip. Pressing there trimmed, every time. **So the fade-in handle
          was unreachable from zero**, and the only way to get a fade was to
          already have one.
          ⚠️ THE DOT HAD z-10 AND THE STRIP HAD NOTHING, so the obvious reading
          was the opposite one, that the dot was stealing the trim. It is not:
          benched on 2026-08-18 by putting the old geometry back, and the drag at
          the clip head trimmed correctly both before and after. Do not "fix"
          this back on the z-index alone.
          ⛔ CLAMPING THE DOT DOES NOT LIE ABOUT THE FADE. The fade's real extent
          is the SVG triangle above; the dot is only the handle you grab. The
          handle moves clear of the trim strip, the readout does not move. */}
      {width >= 32 && interactive && (
        <>
          <div
            data-testid="fade-in-handle"
            className="absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-white/80 bg-white/40 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ left: Math.min(width - trimPx - dotR, Math.max(trimPx + dotR, fadeInPx)) }}
            title="Drag to fade in"
            onPointerDown={(e) => beginFade(e, 'in')}
            onPointerMove={moveFade}
            onPointerUp={endFade}
            onPointerCancel={endFade}
          />
          <div
            data-testid="fade-out-handle"
            className="absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-white/80 bg-white/40 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ left: Math.min(width - trimPx - dotR, Math.max(trimPx + dotR, width - fadeOutPx)) }}
            title="Drag to fade out"
            onPointerDown={(e) => beginFade(e, 'out')}
            onPointerMove={moveFade}
            onPointerUp={endFade}
            onPointerCancel={endFade}
          />
        </>
      )}

      {/* Trim zones shrink on short clips so at least half the body stays
          grabbable - a 0.2s SFX at default zoom is 12px wide, and two fixed
          6px handles used to swallow it whole. Below ~10px, trim by keyboard
          (Q/W) or zoom in; the whole clip is for moving.
          ⛔ z-20 SO THE EDGE ALWAYS TRIMS. It sits above the fade dots' z-10
          deliberately: these two overlap by design at the corners, and DOM
          order is not a decision anybody made. Trimming wins because he does it
          hundreds of times an hour and a wrong one costs an undo. */}
      {width >= 10 && interactive && (
        <>
          <div
            data-testid="trim-in"
            className="absolute inset-y-0 left-0 z-20 cursor-w-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ width: trimPx }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onTrimPointerDown(e, clip, 'in')
            }}
          />
          <div
            data-testid="trim-out"
            className="absolute inset-y-0 right-0 z-20 cursor-e-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ width: trimPx }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onTrimPointerDown(e, clip, 'out')
            }}
          />
        </>
      )}
    </div>
  )
})
