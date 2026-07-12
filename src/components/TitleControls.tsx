// Title editor for a generated title clip (Phase 5). Every control writes
// through updateTitle so each edit is one undo step; the render pipeline
// rasterizes the resulting TitleDef to a texture (preview == export).

import {
  AlignCenter,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  Bold,
  Italic,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import { defaultTitleDef, type Clip, type TitleDef } from '../engine/types'
import { updateTitle } from '../state/titleActions'
import { IconButton } from '../ui/Button'

const FONT_FAMILIES = TITLE_FONT_OPTIONS

const inputCls =
  'h-6 w-full rounded-[4px] bg-bg-input px-2 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

/** Typed number field; commits clamped value on blur/Enter, reverts on Escape. */
function NumberField({
  value,
  min,
  max,
  step = 1,
  testId,
  ariaLabel,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step?: number
  testId?: string
  ariaLabel: string
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const n = Number(text)
    if (Number.isFinite(n)) {
      const clamped = Math.min(max, Math.max(min, n))
      if (clamped !== value) onCommit(clamped)
      setText(String(clamped))
    } else {
      setText(String(value))
    }
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      data-testid={testId}
      aria-label={ariaLabel}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setEditing(false)
          setText(String(value))
          ref.current?.blur()
        }
      }}
      className={`${inputCls} tabular-nums`}
    />
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {label}
      </span>
      {children}
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Segmented row of IconButtons; the matching value shows as active/pressed. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon: typeof AlignLeft }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-[4px] bg-bg-input p-0.5">
      {options.map(({ value: v, label, icon: Icon }) => (
        <IconButton
          key={v}
          size="compact"
          label={label}
          active={value === v}
          onClick={() => onChange(v)}
        >
          <Icon size={14} strokeWidth={1.5} />
        </IconButton>
      ))}
    </div>
  )
}

export function TitleControls({ clip }: { clip: Clip }) {
  const def = clip.title
  if (!def) return null
  const set = (patch: Partial<TitleDef>) => updateTitle(clip.id, patch)

  return (
    <div className="flex flex-col gap-5">
      <Section title="Text">
        <textarea
          data-testid="title-text"
          aria-label="Title text"
          value={def.text}
          onChange={(e) => set({ text: e.target.value })}
          rows={3}
          className="min-h-[60px] w-full resize-y rounded-[4px] bg-bg-input px-2 py-1.5 text-[12px] leading-snug text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </Section>

      <div className="h-px bg-border" />

      <Section title="Font">
        <Field label="Size">
          <NumberField
            value={def.fontSizePx}
            min={8}
            max={400}
            testId="title-fontsize"
            ariaLabel="Font size"
            onCommit={(v) => set({ fontSizePx: v })}
          />
        </Field>
        <Field label="Family">
          <select
            aria-label="Font family"
            value={def.fontFamily}
            onChange={(e) => set({ fontFamily: e.target.value })}
            className={`${inputCls} cursor-default`}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
            {/* Preserve an unknown family so the select never blanks out. */}
            {!FONT_FAMILIES.some((f) => f.value === def.fontFamily) && (
              <option value={def.fontFamily}>Custom</option>
            )}
          </select>
        </Field>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="compact"
            label="Bold"
            active={def.bold}
            onClick={() => set({ bold: !def.bold })}
          >
            <Bold size={14} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="compact"
            label="Italic"
            active={def.italic}
            onClick={() => set({ italic: !def.italic })}
          >
            <Italic size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Color">
        <div className="flex items-center gap-2">
          <input
            type="color"
            data-testid="title-color"
            aria-label="Text color"
            value={hexOf(def.color)}
            onChange={(e) => set({ color: e.target.value })}
            className="h-7 w-9 shrink-0 cursor-default rounded-[4px] bg-bg-input p-0.5"
          />
          <input
            type="text"
            aria-label="Text color hex"
            value={def.color}
            onChange={(e) => set({ color: e.target.value })}
            className={`${inputCls} font-mono`}
          />
        </div>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Align">
        <Field label="Horiz">
          <Segmented
            value={def.align}
            onChange={(align) => set({ align })}
            options={[
              { value: 'left', label: 'Align left', icon: AlignLeft },
              { value: 'center', label: 'Align center', icon: AlignCenter },
              { value: 'right', label: 'Align right', icon: AlignRight },
            ]}
          />
        </Field>
        <Field label="Vert">
          <Segmented
            value={def.vAlign}
            onChange={(vAlign) => set({ vAlign })}
            options={[
              { value: 'top', label: 'Align top', icon: AlignStartVertical },
              { value: 'middle', label: 'Align middle', icon: AlignVerticalJustifyCenter },
              { value: 'bottom', label: 'Align bottom', icon: AlignEndVertical },
            ]}
          />
        </Field>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Position">
        <Field label="Offset X">
          <NumberField
            value={def.offsetXPx}
            min={-4000}
            max={4000}
            ariaLabel="Offset X"
            onCommit={(v) => set({ offsetXPx: v })}
          />
        </Field>
        <Field label="Offset Y">
          <NumberField
            value={def.offsetYPx}
            min={-4000}
            max={4000}
            ariaLabel="Offset Y"
            onCommit={(v) => set({ offsetYPx: v })}
          />
        </Field>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Shadow">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            data-testid="title-shadow-toggle"
            aria-label="Enable shadow"
            checked={!!def.shadow}
            onChange={(e) => set({ shadow: e.target.checked ? defaultTitleDef().shadow : undefined })}
            className="accent-accent"
          />
          Drop shadow
        </label>
        {def.shadow && (
          <div className="flex flex-col gap-2">
            <Field label="Blur">
              <NumberField
                value={def.shadow.blurPx}
                min={0}
                max={200}
                ariaLabel="Shadow blur"
                onCommit={(v) => set({ shadow: { ...def.shadow!, blurPx: v } })}
              />
            </Field>
            <Field label="Offset X">
              <NumberField
                value={def.shadow.dx}
                min={-200}
                max={200}
                ariaLabel="Shadow offset X"
                onCommit={(v) => set({ shadow: { ...def.shadow!, dx: v } })}
              />
            </Field>
            <Field label="Offset Y">
              <NumberField
                value={def.shadow.dy}
                min={-200}
                max={200}
                ariaLabel="Shadow offset Y"
                onCommit={(v) => set({ shadow: { ...def.shadow!, dy: v } })}
              />
            </Field>
            <Field label="Color">
              <input
                type="color"
                aria-label="Shadow color"
                value={hexOf(def.shadow.color)}
                onChange={(e) => set({ shadow: { ...def.shadow!, color: e.target.value } })}
                className="h-7 w-9 shrink-0 cursor-default rounded-[4px] bg-bg-input p-0.5"
              />
            </Field>
          </div>
        )}
      </Section>

      <div className="h-px bg-border" />

      <Section title="Outline">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            data-testid="title-outline-toggle"
            aria-label="Enable outline"
            checked={!!def.outline}
            onChange={(e) => set({ outline: e.target.checked ? { color: '#000000', widthPx: 8 } : undefined })}
            className="accent-accent"
          />
          Outline stroke
        </label>
        {def.outline && (
          <div className="flex flex-col gap-2">
            <Field label="Color">
              <input
                type="color"
                data-testid="title-outline-color"
                aria-label="Outline color"
                value={hexOf(def.outline.color)}
                onChange={(e) => set({ outline: { ...def.outline!, color: e.target.value } })}
                className="h-7 w-9 shrink-0 cursor-default rounded-[4px] bg-bg-input p-0.5"
              />
            </Field>
            <Field label="Width">
              <NumberField
                value={def.outline.widthPx}
                min={0}
                max={100}
                ariaLabel="Outline width"
                onCommit={(v) => set({ outline: { ...def.outline!, widthPx: v } })}
              />
            </Field>
          </div>
        )}
      </Section>

      <div className="h-px bg-border" />

      <Section title="Background">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            data-testid="title-box-toggle"
            aria-label="Enable background"
            checked={!!def.box}
            onChange={(e) =>
              set({
                box: e.target.checked
                  ? { color: 'rgba(0,0,0,0.6)', paddingPx: 24, radiusPx: 8 }
                  : undefined,
              })
            }
            className="accent-accent"
          />
          Box behind text
        </label>
        {def.box && (
          <div className="flex flex-col gap-2">
            <Field label="Color">
              <input
                type="color"
                aria-label="Background color"
                value={hexOf(def.box.color)}
                onChange={(e) => set({ box: { ...def.box!, color: e.target.value } })}
                className="h-7 w-9 shrink-0 cursor-default rounded-[4px] bg-bg-input p-0.5"
              />
            </Field>
            <Field label="Padding">
              <NumberField
                value={def.box.paddingPx}
                min={0}
                max={400}
                ariaLabel="Background padding"
                onCommit={(v) => set({ box: { ...def.box!, paddingPx: v } })}
              />
            </Field>
            <Field label="Radius">
              <NumberField
                value={def.box.radiusPx}
                min={0}
                max={400}
                ariaLabel="Background radius"
                onCommit={(v) => set({ box: { ...def.box!, radiusPx: v } })}
              />
            </Field>
          </div>
        )}
      </Section>
    </div>
  )
}

// A <input type=color> only accepts #rrggbb; strip rgba()/#rrggbbaa down to a
// hex swatch so the picker renders (the text field keeps the exact value).
function hexOf(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7)
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, '0')
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`
  }
  return '#000000'
}
