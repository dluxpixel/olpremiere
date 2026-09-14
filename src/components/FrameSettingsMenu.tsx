// The four sequence-level frame settings, behind one labelled button.
//
// ⛔ WHY THEY LEFT THE BAR. The strip under the picture is a three-column grid
// whose right cell is `min-w-0 overflow-hidden`, and eleven controls were packed
// into it: screenshot, aspect, inner frame, a custom-ratio field, blurred
// background, a band-tightness field that appears only when blur is on, motion
// blur, loop, safe margins, preview quality and fullscreen. Past a certain
// inspector width the cell simply clipped, so controls vanished off the end with
// nothing to say they had. He has complained about this one strip twice.
//
// ⚠️ AND THE FRAME STAYS EXACTLY WHERE IT IS. His call, 2026-09-13, looking at a
// proposal that moved the panels: *"What we have now is not inherently bad. It's
// just not the best. We can improve it. We don't have to change the entirety.
// The base is basically good."* So nothing moves. Four controls that belong
// together get one home with room for their real names, and the bar stops
// clipping. → `olp-design-research-2026-09-12` in the vault.
//
// What stayed on the bar is what he touches while editing: the screenshot, the
// aspect he changes most, loop, preview quality and fullscreen. What came in
// here is what he sets once for a short and leaves alone.

import { Aperture, Frame, Scan, Wind } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CONTENT_ASPECTS, aspectLabel, parseAspect } from '../engine/contentFrame'
import { DEFAULT_SHUTTER_ANGLE } from '../engine/render/motionBlur'
import { BACKDROP_ZOOM, BLUR_BACKDROP_ZOOM } from '../engine/render/resolve'
import type { Sequence } from '../engine/types'
import {
  setActiveSequenceBlurBackdropZoom,
  setActiveSequenceBlurBackground,
  setActiveSequenceContentAspect,
  setActiveSequenceShutterAngle,
} from '../state/store'
import { ScrubField } from './EffectControls'

/** The entry that reveals the free-text ratio field. His "completely custom ratios". */
const CUSTOM_CONTENT_KEY = '__customContent'

/**
 * Which inner-frame entry this sequence is on. 'full' is no inner frame, and
 * CUSTOM_CONTENT_KEY is a ratio he typed that no preset covers.
 *
 * ⛔ A SET RATIO MUST NEVER READ BACK AS 'full'. That would show him "Fill the
 * frame" over a frame that is plainly not filled, and the next thing he touched
 * in the row would have thrown his ratio away.
 */
export function contentAspectKeyFor(seq: Sequence, customOpen: boolean): string {
  const a = seq.contentAspect
  if (customOpen) return CUSTOM_CONTENT_KEY
  if (a === undefined) return 'full'
  return (
    CONTENT_ASPECTS.find((x) => x.aspect !== null && Math.abs(x.aspect - a) < 1e-4)?.key ??
    CUSTOM_CONTENT_KEY
  )
}

/**
 * Is anything in here switched away from its default?
 *
 * The button wears this, because the whole risk of folding controls away is that
 * he cannot tell a setting is on without opening the drawer. Motion blur is ON
 * by default, so "not default" means it has been switched OFF.
 */
export function frameSettingsActive(seq: Sequence, safeMargins: boolean): boolean {
  return (
    seq.contentAspect !== undefined ||
    seq.blurBackground === true ||
    (seq.shutterAngle ?? DEFAULT_SHUTTER_ANGLE) === 0 ||
    safeMargins
  )
}

const ROW = 'flex items-center justify-between gap-3 px-2.5 py-1.5'
const LABEL = 'text-ui-sm text-text-secondary'
const HINT = 'mt-0.5 text-[11px] leading-snug text-text-muted'

interface Props {
  seq: Sequence
  safeMargins: boolean
  onSafeMargins: (v: boolean) => void
}

export function FrameSettingsMenu({ seq, safeMargins, onSafeMargins }: Props) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customRatio, setCustomRatio] = useState('')
  const btnRef = useRef<HTMLButtonElement | null>(null)
  /** Where to pin the panel, in viewport coordinates. Measured from the button. */
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null)

  // Escape closes it. The outside click is a real backdrop element rather than a
  // document listener, the same way AddEffectMenu does it, so a click that
  // dismisses the menu cannot also press the control underneath.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // ⛔ MEASURED AND PORTALLED, NOT POSITIONED ABSOLUTELY. The strip this button
  // sits in is `overflow-hidden` and so is its right cell, both load-bearing:
  // the comments in Monitor.tsx explain that without them a flex overflow paints
  // straight over the transport. A panel rendered inside either one is clipped to
  // a 44px-tall box and never becomes visible, which is exactly what happened the
  // first time this was built. So it goes to the body, pinned to the button's own
  // rectangle, and follows a resize or a scroll.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setAt({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const shutter = seq.shutterAngle ?? DEFAULT_SHUTTER_ANGLE
  const anyOn = frameSettingsActive(seq, safeMargins)

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Frame settings"
        title="Frame: the shape inside your export, the blurred background, motion blur and safe margins"
        data-testid="frame-settings-button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-field border px-2 text-ui-sm transition-colors duration-[120ms] ${
          open || anyOn
            ? 'border-accent bg-accent-quiet text-accent'
            : 'border-border bg-bg-input text-text-secondary hover:border-border-strong hover:text-text-primary'
        }`}
      >
        <Frame size={14} strokeWidth={1.75} aria-hidden />
        Frame
      </button>

      {open &&
        at &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[90]"
              data-testid="frame-settings-backdrop"
              onMouseDown={() => setOpen(false)}
            />
            {/* Opens UPWARD. This strip sits at the BOTTOM of the monitor, so a
                panel hung below it would open off the bottom of the window and
                over the timeline. */}
            <div
              role="dialog"
              aria-label="Frame settings"
              data-testid="frame-settings-menu"
              style={{ right: at.right, bottom: at.bottom }}
              className="fixed z-[91] flex w-72 flex-col rounded-field border border-border-strong bg-bg-elevated py-1 shadow-pop"
            >
            {/* --- the inner frame ------------------------------------------ */}
            <div className="px-2.5 pb-1 pt-1.5">
              <div className={LABEL}>Inside the frame</div>
              <p className={HINT}>
                Your export keeps its shape. The footage sits in a smaller one inside it, like a square
                inside a Short.
              </p>
            </div>
            <div className={ROW}>
              <select
                data-testid="content-aspect-select"
                aria-label="Inner frame"
                className="h-7 min-w-0 flex-1 cursor-default rounded-field border border-border bg-bg-input pl-2 pr-6 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:text-text-primary focus:border-accent focus:outline-none"
                value={contentAspectKeyFor(seq, customOpen)}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_CONTENT_KEY) {
                    // Seed the field with what is on screen now, and change
                    // NOTHING else: opening the field must not move his picture.
                    setCustomRatio(seq.contentAspect ? String(Number(seq.contentAspect.toFixed(4))) : '')
                    setCustomOpen(true)
                    return
                  }
                  setCustomOpen(false)
                  const a = CONTENT_ASPECTS.find((x) => x.key === e.target.value)
                  if (a) setActiveSequenceContentAspect(a.aspect)
                }}
              >
                {CONTENT_ASPECTS.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
                <option value={CUSTOM_CONTENT_KEY}>
                  {contentAspectKeyFor(seq, customOpen) === CUSTOM_CONTENT_KEY && seq.contentAspect
                    ? aspectLabel(seq.contentAspect)
                    : 'Custom...'}
                </option>
              </select>
              {/* Applied on Enter and on blur, never per keystroke: "16:9" passes
                  through "16:" on the way, and applying each character would
                  redraw the frame four times and land on nonsense in between. */}
              {contentAspectKeyFor(seq, customOpen) === CUSTOM_CONTENT_KEY && (
                <input
                  data-testid="content-aspect-custom"
                  aria-label="Custom inner frame ratio"
                  title="Type a ratio like 4:5 or 2.39:1"
                  value={customRatio}
                  placeholder="4:5"
                  onChange={(e) => setCustomRatio(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  onBlur={() => {
                    const a = parseAspect(customRatio)
                    // Nonsense leaves the picture alone and puts the real number
                    // back, rather than silently clearing his frame.
                    if (a === null) setCustomRatio(seq.contentAspect ? seq.contentAspect.toFixed(4) : '')
                    else setActiveSequenceContentAspect(a)
                  }}
                  className="h-7 w-16 shrink-0 rounded-field border border-border bg-bg-input px-2 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:border-border-strong focus:border-accent focus:text-text-primary focus:outline-none"
                />
              )}
            </div>

            <div className="my-1 h-px bg-border" />

            {/* --- the blurred background ----------------------------------- */}
            <label className={`${ROW} cursor-default`}>
              <span className="flex items-center gap-2">
                <Aperture size={14} strokeWidth={1.75} className="text-text-muted" aria-hidden />
                <span className={LABEL}>Blurred background</span>
              </span>
              <input
                type="checkbox"
                data-testid="blur-background-toggle"
                checked={seq.blurBackground === true}
                onChange={(e) => setActiveSequenceBlurBackground(e.target.checked)}
                className="size-4 shrink-0 accent-accent"
              />
            </label>
            {/* His ask, 2026-08-16: "make it so I can change it each single time."
                How far past the frame the band is grown before it blurs, which is
                what decides whether his hotbar shows up in it. Only here when the
                blur is on, so it never sits there meaning nothing. */}
            {seq.blurBackground === true && (
              <div className={ROW}>
                <span className="text-[11px] text-text-muted">Band tightness</span>
                <ScrubField
                  value={seq.blurBackdropZoom ?? BACKDROP_ZOOM}
                  spec={BLUR_BACKDROP_ZOOM}
                  testId="blur-backdrop-zoom"
                  ariaLabel="Blur band tightness"
                  onCommit={setActiveSequenceBlurBackdropZoom}
                />
              </div>
            )}

            {/* --- motion blur ---------------------------------------------- */}
            {/* ON by default at the film standard, because a move with perfectly
                sharp edges is the one thing that reads as made by a computer.
                The renderer works the smear out from how far the picture actually
                travelled, so it needs no keyframes. → engine/render/motionBlur.ts
                ⛔ Still NO shutter-angle box: his call, 2026-08-19, that a dial in
                degrees was useless to him. The toggle is the choice he makes. */}
            <label className={`${ROW} cursor-default`}>
              <span className="flex items-center gap-2">
                <Wind size={14} strokeWidth={1.75} className="text-text-muted" aria-hidden />
                <span className={LABEL}>Motion blur</span>
              </span>
              <input
                type="checkbox"
                data-testid="motion-blur-toggle"
                checked={shutter > 0}
                onChange={(e) => setActiveSequenceShutterAngle(e.target.checked ? DEFAULT_SHUTTER_ANGLE : 0)}
                className="size-4 shrink-0 accent-accent"
              />
            </label>

            {/* --- safe margins --------------------------------------------- */}
            <label className={`${ROW} cursor-default`}>
              <span className="flex items-center gap-2">
                <Scan size={14} strokeWidth={1.75} className="text-text-muted" aria-hidden />
                <span className={LABEL}>Safe margins</span>
              </span>
              <input
                type="checkbox"
                data-testid="safe-margins-toggle"
                checked={safeMargins}
                onChange={(e) => onSafeMargins(e.target.checked)}
                className="size-4 shrink-0 accent-accent"
              />
            </label>
            <p className={`${HINT} px-2.5 pb-1.5`}>
              Guides only. They are never burned into the export.
            </p>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
