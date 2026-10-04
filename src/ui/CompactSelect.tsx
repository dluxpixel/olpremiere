import { useLayoutEffect, useRef } from 'react'

// A native <select> that is only as wide as its short label, and lists the full names when it opens.
//
// His words, 2026-10-04: "make the preview thing smaller because it's taking up too much space.
// Same with the shorts thing. I'm not saying make it completely small, but there's a lot of blank
// space." "Preview: Full" and "9:16 Shorts" were selects sized to their longest option plus room for
// the arrow, so each showed a label and a gap. The closed select now says "Full" and "9:16", and the
// list that opens says "Full quality" and "9:16 Shorts".
//
// How: Chromium's customizable select (`appearance: base-select`, Chrome 135, so the desktop app and
// every current browser but Safari) lets an <option> hold more than text. Each option carries BOTH
// names; the picker hides the short one and the closed button, which is a copy of the chosen option,
// hides the long one (src/index.css, .compact-select). It is still a real <select>: the value, the
// keyboard, Playwright's selectOption and a screen reader all work as they did.
//
// A browser without it (iOS Safari, an old one) gets the plain select with the long names, which is
// what it had before, never two names run together.
//
// ⛔ BUILT BY HAND, NOT AS REACT CHILDREN. React will not put a <button> inside a <select> or a <span>
// inside an <option>, and both are what the customizable select is made of, so the options are written
// into the element in a layout effect and the value is set the same way. `options` must keep its
// identity between renders (a module constant or a useMemo) or the list is rebuilt every time.

const BASE_SELECT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('appearance', 'base-select')

export interface CompactOption {
  value: string
  /** What the closed select says. */
  short: string
  /** What the list says, and the screen reader. */
  long: string
  disabled?: boolean
}

export interface CompactSelectProps {
  value: string
  options: readonly CompactOption[]
  onChange: (value: string) => void
  /** The accessible name. */
  label: string
  /** The tooltip: what this is and what each choice means. */
  title: string
  testId?: string
  className?: string
}

/**
 * Put a copy of the chosen option on the face of the closed select.
 *
 * The browser does this itself for a select it parsed, but not for one whose options were written
 * after it was on the page (measured in Chromium 149: the face stayed empty and the select shrank
 * to its arrow), and writing them afterwards is the only way React lets us build it. Copying is all
 * it does, so doing it again when the browser already has is harmless.
 */
function showChosen(el: HTMLSelectElement): void {
  if (!BASE_SELECT) return
  const face = el.querySelector('selectedcontent')
  const chosen = el.selectedOptions[0]
  if (!face || !chosen) return
  face.replaceChildren(...Array.from(chosen.childNodes, (n) => n.cloneNode(true)))
}

export function CompactSelect({ value, options, onChange, label, title, testId, className = '' }: CompactSelectProps) {
  const ref = useRef<HTMLSelectElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Written as one piece of markup, the way a page would be: the face copies the chosen option
    // only for a select the PARSER built (built node by node with createElement it stays empty,
    // measured in Chromium 149). Every string in it is ours, and still goes through esc().
    const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const face = BASE_SELECT ? '<button type="button"><selectedcontent></selectedcontent></button>' : ''
    const list = options
      .map((o) => {
        const inner = BASE_SELECT
          ? `<span class="opt-short">${esc(o.short)}</span><span class="opt-long">${esc(o.long)}</span>`
          : esc(o.long)
        return `<option value="${esc(o.value)}"${o.disabled ? ' disabled' : ''}>${inner}</option>`
      })
      .join('')
    el.innerHTML = face + list
    el.value = valueRef.current
    showChosen(el)
  }, [options])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.value = value
    showChosen(el)
  }, [value])

  return (
    <select
      ref={ref}
      className={`compact-select ${className}`}
      aria-label={label}
      title={title}
      data-testid={testId}
      onChange={(e) => {
        showChosen(e.target)
        onChange(e.target.value)
        // If the answer was refused the select must go back to what is true.
        const el = e.target
        queueMicrotask(() => {
          el.value = valueRef.current
        })
      }}
    />
  )
}
