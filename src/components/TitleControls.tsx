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
  CaseLower,
  CaseUpper,
  Italic,
} from 'lucide-react'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import { defaultTitleDef, type Clip, type TitleDef } from '../engine/types'
import { setTitlesFontSize, updateTitle } from '../state/titleActions'
import { IconButton } from '../ui/Button'
import { PropRow, ScrubField, SectionLabel, type Spec } from './EffectControls'

const FONT_FAMILIES = TITLE_FONT_OPTIONS

const inputCls =
  'h-6 w-full rounded-field bg-bg-input px-2 text-ui-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

// Per-field reset targets: the same defaults the toggles create with.
const TITLE_DEFAULTS = defaultTitleDef()

/** Typed number field; commits clamped value on blur/Enter, reverts on Escape. */
/**
 * A title number field. Delegates to the shared ScrubField so it drag-scrubs
 * exactly like every effect-param field - the gesture that used to silently
 * fail here (size, offsets, shadow, outline, box all looked scrubbable but
 * weren't). Same commit path (updateTitle = one undo).
 */
function NumberField({
  value,
  min,
  max,
  step = 1,
  sens,
  testId,
  ariaLabel,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step?: number
  sens?: number
  testId?: string
  ariaLabel: string
  onCommit: (v: number) => void
}) {
  const spec: Spec = { min, max, step, sens: sens ?? Math.max(step, (max - min) / 1500) }
  return (
    <ScrubField
      value={value}
      spec={spec}
      testId={testId ?? `title-num-${ariaLabel.toLowerCase().replace(/\s+/g, '-')}`}
      ariaLabel={ariaLabel}
      onCommit={onCommit}
    />
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{title}</SectionLabel>
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
    <div className="flex items-center gap-0.5 rounded-field bg-bg-input p-0.5">
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
  // `mergeField` marks a control that fires CONTINUOUSLY (a text box being
  // typed into, a colour picker being dragged, an arrow key held down on a
  // number field), so the whole run collapses to one undo step instead of one
  // step per event.
  const set = (patch: Partial<TitleDef>, mergeField?: keyof TitleDef) =>
    updateTitle(clip.id, patch, mergeField)

  return (
    <div className="flex flex-col gap-5">
      <Section title="Text">
        <textarea
          data-testid="title-text"
          aria-label="Title text"
          value={def.text}
          onChange={(e) => set({ text: e.target.value }, 'text')}
          rows={3}
          className="min-h-[60px] w-full resize-y rounded-field bg-bg-input px-2 py-1.5 text-ui-sm leading-snug text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </Section>

      <div className="h-px bg-border" />

      <Section title="Font">
        <PropRow
          label="Size"
          onReset={() => setTitlesFontSize([clip.id], TITLE_DEFAULTS.fontSizePx)}
          resetLabel="Reset font size"
        >
          <NumberField
            value={def.fontSizePx}
            min={8}
            max={400}
            testId="title-fontsize"
            ariaLabel="Font size"
            onCommit={(v) => setTitlesFontSize([clip.id], v, 'fontSizePx')}
          />
        </PropRow>
        <PropRow label="Family">
          <select
            aria-label="Font family"
            value={def.fontFamily}
            onChange={(e) => set({ fontFamily: e.target.value })}
            className="h-6 w-[140px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
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
        </PropRow>
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
          <div className="mx-0.5 h-4 w-px bg-border" />
          <IconButton
            size="compact"
            label="UPPERCASE"
            active={def.textCase === 'upper'}
            data-testid="title-case-upper"
            onClick={() => set({ textCase: def.textCase === 'upper' ? undefined : 'upper' })}
          >
            <CaseUpper size={15} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="compact"
            label="lowercase"
            active={def.textCase === 'lower'}
            data-testid="title-case-lower"
            onClick={() => set({ textCase: def.textCase === 'lower' ? undefined : 'lower' })}
          >
            <CaseLower size={15} strokeWidth={1.5} />
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
            onChange={(e) => set({ color: e.target.value }, 'color')}
            className="h-7 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
          />
          <input
            type="text"
            aria-label="Text color hex"
            value={def.color}
            onChange={(e) => set({ color: e.target.value }, 'color')}
            className={`${inputCls} font-mono`}
          />
          {/* The caption workflow flips single words to a highlight color
              constantly - one click, no picker round-trip. */}
          {[
            { hex: '#ffffff', label: 'White' },
            { hex: '#FFD400', label: 'Highlight yellow' },
            { hex: '#3B7DFF', label: 'Highlight blue' },
          ].map((c) => (
            <button
              key={c.hex}
              type="button"
              data-testid={`title-swatch-${c.hex.slice(1).toLowerCase()}`}
              aria-label={c.label}
              title={c.label}
              onClick={() => set({ color: c.hex })}
              className={`h-6 w-6 shrink-0 rounded-field border transition-transform duration-[120ms] hover:scale-110 ${
                def.color.toLowerCase() === c.hex.toLowerCase() ? 'border-accent' : 'border-border-strong'
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Align">
        <PropRow label="Horiz" labelTitle="Horizontal alignment">
          <Segmented
            value={def.align}
            onChange={(align) => set({ align })}
            options={[
              { value: 'left', label: 'Align left', icon: AlignLeft },
              { value: 'center', label: 'Align center', icon: AlignCenter },
              { value: 'right', label: 'Align right', icon: AlignRight },
            ]}
          />
        </PropRow>
        <PropRow label="Vert" labelTitle="Vertical alignment">
          <Segmented
            value={def.vAlign}
            onChange={(vAlign) => set({ vAlign })}
            options={[
              { value: 'top', label: 'Align top', icon: AlignStartVertical },
              { value: 'middle', label: 'Align middle', icon: AlignVerticalJustifyCenter },
              { value: 'bottom', label: 'Align bottom', icon: AlignEndVertical },
            ]}
          />
        </PropRow>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Position">
        <PropRow label="Offset X" onReset={() => set({ offsetXPx: 0 })} resetLabel="Reset offset X">
          <NumberField
            value={def.offsetXPx}
            min={-4000}
            max={4000}
            ariaLabel="Offset X"
            onCommit={(v) => set({ offsetXPx: v }, 'offsetXPx')}
          />
        </PropRow>
        <PropRow label="Offset Y" onReset={() => set({ offsetYPx: 0 })} resetLabel="Reset offset Y">
          <NumberField
            value={def.offsetYPx}
            min={-4000}
            max={4000}
            ariaLabel="Offset Y"
            onCommit={(v) => set({ offsetYPx: v }, 'offsetYPx')}
          />
        </PropRow>
      </Section>

      <div className="h-px bg-border" />

      <Section title="Shadow">
        <PropRow
          label="Drop shadow"
          labelFor="title-shadow-on"
          lead={
            <input
              type="checkbox"
              id="title-shadow-on"
              data-testid="title-shadow-toggle"
              aria-label="Enable shadow"
              checked={!!def.shadow}
              onChange={(e) => set({ shadow: e.target.checked ? defaultTitleDef().shadow : undefined })}
              className="ml-1 accent-accent"
            />
          }
        />
        {def.shadow && (
          <div className="flex flex-col gap-1">
            <PropRow
              label="Blur"
              onReset={() => set({ shadow: { ...def.shadow!, blurPx: TITLE_DEFAULTS.shadow!.blurPx } })}
              resetLabel="Reset shadow blur"
            >
              <NumberField
                value={def.shadow.blurPx}
                min={0}
                max={200}
                ariaLabel="Shadow blur"
                onCommit={(v) => set({ shadow: { ...def.shadow!, blurPx: v } }, 'shadow')}
              />
            </PropRow>
            <PropRow
              label="Offset X"
              onReset={() => set({ shadow: { ...def.shadow!, dx: TITLE_DEFAULTS.shadow!.dx } })}
              resetLabel="Reset shadow offset X"
            >
              <NumberField
                value={def.shadow.dx}
                min={-200}
                max={200}
                ariaLabel="Shadow offset X"
                onCommit={(v) => set({ shadow: { ...def.shadow!, dx: v } }, 'shadow')}
              />
            </PropRow>
            <PropRow
              label="Offset Y"
              onReset={() => set({ shadow: { ...def.shadow!, dy: TITLE_DEFAULTS.shadow!.dy } })}
              resetLabel="Reset shadow offset Y"
            >
              <NumberField
                value={def.shadow.dy}
                min={-200}
                max={200}
                ariaLabel="Shadow offset Y"
                onCommit={(v) => set({ shadow: { ...def.shadow!, dy: v } }, 'shadow')}
              />
            </PropRow>
            <PropRow label="Color" labelTitle="Shadow color">
              <input
                type="color"
                aria-label="Shadow color"
                value={hexOf(def.shadow.color)}
                onChange={(e) => set({ shadow: { ...def.shadow!, color: e.target.value } }, 'shadow')}
                className="h-6 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
              />
            </PropRow>
          </div>
        )}
      </Section>

      <div className="h-px bg-border" />

      <Section title="Outline">
        <PropRow
          label="Outline stroke"
          labelFor="title-outline-on"
          lead={
            <input
              type="checkbox"
              id="title-outline-on"
              data-testid="title-outline-toggle"
              aria-label="Enable outline"
              checked={!!def.outline}
              onChange={(e) => set({ outline: e.target.checked ? { color: '#000000', widthPx: 8 } : undefined })}
              className="ml-1 accent-accent"
            />
          }
        />
        {def.outline && (
          <div className="flex flex-col gap-1">
            <PropRow label="Color" labelTitle="Outline color">
              <input
                type="color"
                data-testid="title-outline-color"
                aria-label="Outline color"
                value={hexOf(def.outline.color)}
                onChange={(e) => set({ outline: { ...def.outline!, color: e.target.value } }, 'outline')}
                className="h-6 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
              />
            </PropRow>
            <PropRow
              label="Width"
              onReset={() => set({ outline: { ...def.outline!, widthPx: 8 } })}
              resetLabel="Reset outline width"
            >
              <NumberField
                value={def.outline.widthPx}
                min={0}
                max={100}
                ariaLabel="Outline width"
                onCommit={(v) => set({ outline: { ...def.outline!, widthPx: v } }, 'outline')}
              />
            </PropRow>
          </div>
        )}
      </Section>

      <div className="h-px bg-border" />

      <Section title="Background">
        <PropRow
          label="Box behind text"
          labelFor="title-box-on"
          lead={
            <input
              type="checkbox"
              id="title-box-on"
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
              className="ml-1 accent-accent"
            />
          }
        />
        {def.box && (
          <div className="flex flex-col gap-1">
            <PropRow label="Color" labelTitle="Background color">
              <input
                type="color"
                aria-label="Background color"
                value={hexOf(def.box.color)}
                onChange={(e) => set({ box: { ...def.box!, color: e.target.value } }, 'box')}
                className="h-6 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
              />
            </PropRow>
            <PropRow
              label="Padding"
              onReset={() => set({ box: { ...def.box!, paddingPx: 24 } })}
              resetLabel="Reset background padding"
            >
              <NumberField
                value={def.box.paddingPx}
                min={0}
                max={400}
                ariaLabel="Background padding"
                onCommit={(v) => set({ box: { ...def.box!, paddingPx: v } }, 'box')}
              />
            </PropRow>
            <PropRow
              label="Radius"
              onReset={() => set({ box: { ...def.box!, radiusPx: 8 } })}
              resetLabel="Reset background radius"
            >
              <NumberField
                value={def.box.radiusPx}
                min={0}
                max={400}
                ariaLabel="Background radius"
                onCommit={(v) => set({ box: { ...def.box!, radiusPx: v } }, 'box')}
              />
            </PropRow>
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
