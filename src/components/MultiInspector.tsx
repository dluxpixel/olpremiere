// The Inspector body when MORE THAN ONE clip is selected. Every control here
// fans out to the whole selection in ONE undo step (see state/bulkEdits.ts,
// updateTitles, applyPunchyGradeToClips). Displayed values come from the first
// selected clip of the relevant kind - committing writes an ABSOLUTE value to
// all of them, so a mixed selection converges on one click. This is what makes
// "select many, edit boldness / effects on all" work.

import { Bold, CaseLower, CaseUpper, Italic, Sparkles, Layers } from 'lucide-react'
import {
  applyEffectToClips,
  clearEffectsForClips,
  setChannelForClips,
  setClipsFade,
  setClipsGainDb,
} from '../state/bulkEdits'
import { ENTRANCE_PRESETS } from '../engine/anim/appearance'
import { setClipsAppearance } from '../state/appearanceActions'
import { applyPunchyGradeToClips } from '../state/lookActions'
import {
  applyTextPresetToClips,
  builtinTextPresets,
  captureTextPreset,
  useTextPresets,
} from '../state/textPresets'
import { setTitlesFontSize, updateTitles } from '../state/titleActions'
import { EFFECTS } from '../engine/effects/registry'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import { clipDurationS } from '../engine/timeline'
import type { Clip, Track } from '../engine/types'
import { IconButton } from '../ui/Button'
import { PropRow, ScrubField, SectionLabel, type Spec } from './EffectControls'

const OPACITY_SPEC: Spec = { min: 0, max: 1, step: 0.01, sens: 0.005 }
const SCALE_SPEC: Spec = { min: 0, max: 5, step: 0.01, sens: 0.01 }
const SIZE_SPEC: Spec = { min: 8, max: 400, step: 1, sens: 0.5 }
const GAIN_SPEC: Spec = { min: -60, max: 12, step: 0.5, sens: 0.2 }
const FADE_SPEC: Spec = { min: 0, max: 30, step: 0.05, sens: 0.02 }

const SWATCHES = [
  { hex: '#ffffff', label: 'White' },
  { hex: '#FFD400', label: 'Highlight yellow' },
  { hex: '#3B7DFF', label: 'Highlight blue' },
]

export interface SelectedClip {
  clip: Clip
  track: Track
  /** True when this clip actually contributes sound (mirrors the single Inspector). */
  emitsAudio: boolean
}

function Header({ label, icon: Icon }: { label: string; icon?: typeof Bold }) {
  return (
    <div className="flex items-center gap-1.5">
      {Icon && <Icon size={12} strokeWidth={2} className="text-text-muted" aria-hidden />}
      <SectionLabel>{label}</SectionLabel>
    </div>
  )
}

export function MultiInspector({ selected }: { selected: SelectedClip[] }) {
  const allIds = selected.map((s) => s.clip.id)
  const titles = selected.filter((s) => s.clip.title)
  const titleIds = titles.map((s) => s.clip.id)
  const audio = selected.filter((s) => s.emitsAudio)
  const audioIds = audio.map((s) => s.clip.id)

  const nTitle = titles.length
  const nVideo = selected.filter((s) => s.track.kind === 'video' && !s.clip.title).length
  const nAudio = selected.filter((s) => s.track.kind === 'audio').length

  // Representative values (first clip of the relevant kind).
  const firstTitle = titles[0]?.clip.title
  const first = selected[0].clip
  const allBold = nTitle > 0 && titles.every((s) => s.clip.title!.bold)
  const allItalic = nTitle > 0 && titles.every((s) => s.clip.title!.italic)
  const allUpper = nTitle > 0 && titles.every((s) => s.clip.title!.textCase === 'upper')
  const allLower = nTitle > 0 && titles.every((s) => s.clip.title!.textCase === 'lower')
  const firstOutline = firstTitle?.outline
  const allOutline = nTitle > 0 && titles.every((s) => !!s.clip.title!.outline)
  const firstAppearanceIn = titles[0]?.clip.appearance?.in
  const savedPresets = useTextPresets((s) => s.saved)
  const presets = [...builtinTextPresets(), ...savedPresets]

  const parts = [
    nTitle ? `${nTitle} text` : '',
    nVideo ? `${nVideo} video` : '',
    nAudio ? `${nAudio} audio` : '',
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-4 p-3" data-testid="multi-inspector">
      <div>
        <div className="text-ui font-medium text-text-primary">{selected.length} clips selected</div>
        <div className="mt-0.5 text-dense text-text-muted">
          {parts.join(' · ')} (edits apply to all)
        </div>
      </div>

      {nTitle > 0 && (
        <>
          <div className="h-px bg-border" />
          <section className="flex flex-col gap-2" data-testid="multi-text">
            <Header label={`Text · ${nTitle}`} icon={Bold} />
            <div className="flex items-center gap-0.5">
              <IconButton
                size="compact"
                label="Bold all"
                active={allBold}
                data-testid="multi-bold"
                onClick={() => updateTitles(titleIds, { bold: !allBold })}
              >
                <Bold size={14} strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="compact"
                label="Italic all"
                active={allItalic}
                data-testid="multi-italic"
                onClick={() => updateTitles(titleIds, { italic: !allItalic })}
              >
                <Italic size={14} strokeWidth={1.5} />
              </IconButton>
              <div className="mx-0.5 h-4 w-px bg-border" />
              <IconButton
                size="compact"
                label="UPPERCASE all"
                active={allUpper}
                data-testid="multi-case-upper"
                onClick={() => updateTitles(titleIds, { textCase: allUpper ? undefined : 'upper' })}
              >
                <CaseUpper size={15} strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="compact"
                label="lowercase all (fix Whisper caps)"
                active={allLower}
                data-testid="multi-case-lower"
                onClick={() => updateTitles(titleIds, { textCase: allLower ? undefined : 'lower' })}
              >
                <CaseLower size={15} strokeWidth={1.5} />
              </IconButton>
            </div>
            <PropRow label="Family">
              <select
                aria-label="Font family (all)"
                data-testid="multi-family"
                value={firstTitle?.fontFamily ?? ''}
                onChange={(e) => updateTitles(titleIds, { fontFamily: e.target.value })}
                className="h-6 w-[140px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
              >
                {TITLE_FONT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
                {firstTitle && !TITLE_FONT_OPTIONS.some((f) => f.value === firstTitle.fontFamily) && (
                  <option value={firstTitle.fontFamily}>Custom</option>
                )}
              </select>
            </PropRow>
            <PropRow label="Size">
              <ScrubField
                value={firstTitle?.fontSizePx ?? 64}
                spec={SIZE_SPEC}
                testId="multi-fontsize"
                ariaLabel="Font size (all)"
                onCommit={(v) => setTitlesFontSize(titleIds, v)}
              />
            </PropRow>
            <div className="flex items-center gap-2">
              <input
                type="color"
                data-testid="multi-color"
                aria-label="Text color (all)"
                value={hexOf(firstTitle?.color ?? '#ffffff')}
                onChange={(e) => updateTitles(titleIds, { color: e.target.value }, 'color')}
                className="h-7 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
              />
              {SWATCHES.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  aria-label={`${c.label} (all)`}
                  title={c.label}
                  onClick={() => updateTitles(titleIds, { color: c.hex })}
                  className="h-6 w-6 shrink-0 rounded-field border border-border-strong transition-transform duration-[120ms] hover:scale-110"
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>

            {/* Outline: colour + width across all selected captions. */}
            <PropRow
              label="Outline"
              labelFor="multi-outline-on"
              lead={
                <input
                  type="checkbox"
                  id="multi-outline-on"
                  data-testid="multi-outline-toggle"
                  aria-label="Outline (all)"
                  checked={allOutline}
                  onChange={(e) =>
                    updateTitles(titleIds, { outline: e.target.checked ? { color: '#000000', widthPx: 10 } : undefined })
                  }
                  className="ml-1 accent-accent"
                />
              }
            />
            {allOutline && (
              <>
                <PropRow label="Color" labelTitle="Outline color (all)">
                  <input
                    type="color"
                    data-testid="multi-outline-color"
                    aria-label="Outline color (all)"
                    value={hexOf(firstOutline?.color ?? '#000000')}
                    onChange={(e) =>
                      updateTitles(
                        titleIds,
                        { outline: { color: e.target.value, widthPx: firstOutline?.widthPx ?? 10 } },
                        'outline',
                      )
                    }
                    className="h-6 w-9 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
                  />
                </PropRow>
                <PropRow label="Width" labelTitle="Outline width (all)">
                  <ScrubField
                    value={firstOutline?.widthPx ?? 10}
                    spec={{ min: 0, max: 100, step: 1, sens: 0.3 }}
                    testId="multi-outline-width"
                    ariaLabel="Outline width (all)"
                    onCommit={(v) => updateTitles(titleIds, { outline: { color: firstOutline?.color ?? '#000000', widthPx: v } })}
                  />
                </PropRow>
              </>
            )}

            {/* Entrance animation across all selected captions. */}
            <PropRow label="Animation">
              <select
                aria-label="Entrance animation (all)"
                data-testid="multi-animation"
                value={firstAppearanceIn ?? ''}
                onChange={(e) => setClipsAppearance(titleIds, { in: e.target.value || undefined })}
                className="h-6 w-[140px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
              >
                <option value="">None</option>
                {ENTRANCE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </PropRow>

            {/* Style presets: apply a saved look (font+case+colour+outline+animation)
                to the whole selection, or save the current one for reuse. */}
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Apply style preset"
                data-testid="multi-preset-apply"
                value=""
                onChange={(e) => {
                  const p = presets.find((x) => x.id === e.target.value)
                  if (p) applyTextPresetToClips(titleIds, p)
                }}
                className="h-6 flex-1 cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
              >
                <option value="">Apply preset…</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="multi-preset-save"
                title="Save this caption's style + animation as a preset"
                onClick={() => {
                  const p = captureTextPreset(titleIds[0], `Style ${useTextPresets.getState().saved.length + 1}`)
                  if (p) useTextPresets.getState().add(p)
                }}
                className="h-6 rounded-field bg-bg-input px-2 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
              >
                Save
              </button>
            </div>
          </section>
        </>
      )}

      <div className="h-px bg-border" />
      <section className="flex flex-col gap-2" data-testid="multi-adjust">
        <Header label="Adjust" />
        <div className="flex flex-col gap-1">
          <PropRow
            label="Opacity"
            onReset={() => setChannelForClips(allIds, 'opacity', 1)}
            resetLabel="Reset opacity (all)"
          >
            <ScrubField
              value={first.opacity ?? 1}
              spec={OPACITY_SPEC}
              testId="multi-opacity"
              ariaLabel="Opacity (all)"
              onCommit={(v) => setChannelForClips(allIds, 'opacity', v)}
            />
          </PropRow>
          <PropRow
            label="Scale"
            onReset={() => setChannelForClips(allIds, 'scale', 1)}
            resetLabel="Reset scale (all)"
          >
            <ScrubField
              value={first.transform.scale ?? 1}
              spec={SCALE_SPEC}
              testId="multi-scale"
              ariaLabel="Scale (all)"
              onCommit={(v) => setChannelForClips(allIds, 'scale', v)}
            />
          </PropRow>
        </div>
      </section>

      <div className="h-px bg-border" />
      <section className="flex flex-col gap-2" data-testid="multi-effects">
        <Header label="Effects" icon={Sparkles} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="multi-punch-grade"
            onClick={() => applyPunchyGradeToClips(allIds)}
            className="flex h-7 items-center gap-1.5 rounded-field bg-bg-input px-2.5 text-ui-sm font-medium text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated"
          >
            <Sparkles size={13} strokeWidth={1.75} aria-hidden />
            Punch grade
          </button>
          <button
            type="button"
            data-testid="multi-clear-effects"
            onClick={() => clearEffectsForClips(allIds)}
            className="flex h-7 items-center gap-1.5 rounded-field bg-bg-input px-2.5 text-ui-sm font-medium text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated"
          >
            <Layers size={13} strokeWidth={1.75} aria-hidden />
            Clear
          </button>
        </div>
        <PropRow label="Add effect">
          <select
            aria-label="Add effect to all"
            data-testid="multi-add-effect"
            value=""
            onChange={(e) => {
              if (e.target.value) applyEffectToClips(allIds, e.target.value)
            }}
            className="h-6 w-[140px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
          >
            <option value="">Choose…</option>
            {EFFECTS.map((ef) => (
              <option key={ef.type} value={ef.type}>
                {ef.label}
              </option>
            ))}
          </select>
        </PropRow>
      </section>

      {audioIds.length > 0 && (
        <>
          <div className="h-px bg-border" />
          <section className="flex flex-col gap-2" data-testid="multi-audio">
            <Header label={`Audio · ${audioIds.length}`} />
            <div className="flex flex-col gap-1">
              <PropRow
                label="Volume"
                onReset={() => setClipsGainDb(audioIds, 0)}
                resetLabel="Reset volume (all)"
              >
                <ScrubField
                  value={audio[0].clip.audioGainDb}
                  spec={GAIN_SPEC}
                  testId="multi-gain"
                  ariaLabel="Volume dB (all)"
                  onCommit={(v) => setClipsGainDb(audioIds, v)}
                />
              </PropRow>
              <PropRow
                label="Fade in (s)"
                onReset={() => setClipsFade(audioIds, 'in', 0)}
                resetLabel="Reset fade in (all)"
              >
                <ScrubField
                  value={audio[0].clip.fadeInS}
                  spec={{ ...FADE_SPEC, max: Math.max(0.05, clipDurationS(audio[0].clip)) }}
                  testId="multi-fade-in"
                  ariaLabel="Fade in seconds (all)"
                  onCommit={(v) => setClipsFade(audioIds, 'in', v)}
                />
              </PropRow>
              <PropRow
                label="Fade out (s)"
                onReset={() => setClipsFade(audioIds, 'out', 0)}
                resetLabel="Reset fade out (all)"
              >
                <ScrubField
                  value={audio[0].clip.fadeOutS}
                  spec={{ ...FADE_SPEC, max: Math.max(0.05, clipDurationS(audio[0].clip)) }}
                  testId="multi-fade-out"
                  ariaLabel="Fade out seconds (all)"
                  onCommit={(v) => setClipsFade(audioIds, 'out', v)}
                />
              </PropRow>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// Mirror TitleControls: a <input type=color> only accepts #rrggbb.
function hexOf(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7)
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, '0')
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`
  }
  return '#ffffff'
}
