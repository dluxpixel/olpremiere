// The Captions tab: make captions, style them, and read every one of them.
//
// His words, 2026-10-03: *"let's completely rework the captions tab. It just
// doesn't look good, and it doesn't have a lot of features. A good auto caption
// thing from, for example, Adobe Premiere would do."* So it reads like
// Premiere's Text panel and Create captions together, in three parts:
//
//   Create    caption the selection, the voiceover, or every clip; the style
//             new captions get, the language, the key word highlight, and the
//             job's progress while it runs.
//   Style     his saved caption styles (look AND length), edited, saved, named,
//             made the default, and put on captions that already exist.
//   Captions  every caption as text he can fix in place; a click jumps there.
//
// It lives in the left column beside Media and Words, the three columns stay as
// they are, and it is built from the parts the Inspector already uses.

import {
  AlignEndVertical,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  Bold,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  ChevronDown,
  ChevronRight,
  Italic,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ENTRANCE_PRESETS, EXIT_PRESETS } from '../engine/anim/appearance'
import {
  BUILTIN_CAPTION_STYLES,
  SHAPE_LIMITS,
  captionDefFor,
  cleanShape,
  lookOfTitle,
  type CaptionLook,
  type CaptionShape,
  type CaptionStyle,
} from '../engine/captions/captionStyle'
import {
  CAPTION_LANGUAGES,
  getCaptionEmphasis,
  getCaptionLanguage,
  setCaptionEmphasis,
  setCaptionLanguage,
  type CaptionLanguage,
} from '../engine/captions/transcribeConfig'
import { CAPTION_FONT_STACK, TITLE_FONT_OPTIONS, ensureTitleFont } from '../engine/render/titleFonts'
import { clipEndS } from '../engine/timeline'
import { activeSequence, type AppearanceSpec, type Clip, type EffectInstance } from '../engine/types'
import { applyCaptionStyle, captionsOn, setCaptionText } from '../state/captionActions'
import {
  captionJobLabel,
  captionJobProgress,
  captionTargets,
  captionTheseClips,
  voiceoverClipId,
} from '../state/captionRun'
import {
  allCaptionStyles,
  defaultCaptionStyle,
  deleteCaptionStyle,
  renameCaptionStyle,
  saveNewCaptionStyle,
  setDefaultCaptionStyle,
  uniqueStyleName,
  updateCaptionStyle,
  useCaptionStyles,
  type CaptionStyleDraft,
} from '../state/captionStyles'
import { askForName } from '../state/namePrompt'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { audibleClips, autoCaptionEveryClip, autoCaptionFromClip, useTranscribe } from '../state/transcribeActions'
import { Button, IconButton } from '../ui/Button'
import { createArmedDelete, type ArmedDelete } from './armedDelete'
import { CaptionsDialog, type ScriptMode } from './CaptionsDialog'
import { ScrubField, SectionLabel } from './EffectControls'

// ---------------------------------------------------------------------------
// Small parts

const selectCls =
  'h-6 min-w-0 cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

/** Which parts are folded, kept per viewer so the tab opens the way he left it. */
const FOLDS_KEY = 'olpremiere:captions:tab-folds'
function readFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function useFold(id: string, openByDefault: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => readFolds()[id] ?? openByDefault)
  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = !was
      try {
        localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...readFolds(), [id]: next }))
      } catch {
        // Private mode: the fold still works, it just opens as default next time.
      }
      return next
    })
  }, [id])
  return [open, toggle]
}

/**
 * One setting: its name on the left, its control on the right. The Inspector's
 * PropRow keeps two 24px gutters for keyframe stopwatches, which a caption
 * style has none of, and in a 280px column those gutters cut "Language" down to
 * "Langu...". Same type, same colours, a wider name.
 */
function Row({
  label,
  labelTitle,
  labelFor,
  lead,
  onReset,
  resetLabel,
  children,
}: {
  label: string
  labelTitle?: string
  labelFor?: string
  lead?: ReactNode
  onReset?: () => void
  resetLabel?: string
  children?: ReactNode
}) {
  const labelCls = 'min-w-0 cursor-default truncate text-ui text-text-secondary'
  // A switch with nothing beside it gets the whole width for its name.
  const alone = children === undefined && !onReset
  return (
    <div className={`grid min-h-7 items-center gap-x-2 ${alone ? 'grid-cols-1' : 'grid-cols-[108px_minmax(0,1fr)]'}`}>
      <span className="flex min-w-0 items-center gap-1.5">
        {lead}
        {labelFor ? (
          <label htmlFor={labelFor} title={labelTitle ?? label} className={labelCls}>
            {label}
          </label>
        ) : (
          <span title={labelTitle ?? label} className={labelCls}>
            {label}
          </span>
        )}
      </span>
      <div className={`flex min-w-0 items-center justify-end gap-1 ${alone ? 'hidden' : ''}`}>
        {children}
        {onReset && (
          <IconButton label={resetLabel ?? `Reset ${label}`} size="compact" onClick={onReset}>
            <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </div>
    </div>
  )
}

/** A part of the tab: a header that folds it, and what it holds. */
function Part({
  title,
  open,
  onToggle,
  aside,
  testId,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  aside?: ReactNode
  testId: string
  children: ReactNode
}) {
  return (
    <section data-testid={testId} className="border-b border-border">
      <div className="flex h-8 items-center gap-1 pl-2 pr-3">
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${testId}-fold`}
          onClick={onToggle}
          className="flex h-6 min-w-0 cursor-default items-center gap-1 rounded-field px-1 text-text-muted transition-colors duration-[120ms] hover:text-text-secondary"
        >
          {open ? <ChevronDown size={13} strokeWidth={1.75} /> : <ChevronRight size={13} strokeWidth={1.75} />}
          <SectionLabel>{title}</SectionLabel>
        </button>
        <div className="ml-auto flex min-w-0 items-center gap-1">{aside}</div>
      </div>
      {open && <div className="flex flex-col gap-2 px-3 pb-3">{children}</div>}
    </section>
  )
}

/** A row of text choices, one lit. Same skin as the Inspector's icon rows. */
function Choice<T extends string | number>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T
  options: { value: T; label: ReactNode; title: string }[]
  onChange: (v: T) => void
  testId: string
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-field bg-bg-input p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-label={o.title}
          aria-pressed={value === o.value}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={`flex h-5 min-w-[22px] cursor-default items-center justify-center rounded-field px-1.5 text-[11px] font-medium transition-colors duration-[120ms] ${
            value === o.value ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A colour well. A colour the picker cannot hold (rgba) shows as its nearest hex. */
function ColourWell({ value, onChange, label, testId }: { value: string; onChange: (hex: string) => void; label: string; testId: string }) {
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      data-testid={testId}
      value={splitColour(value).hex}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 w-8 shrink-0 cursor-default rounded-field bg-bg-input p-0.5"
    />
  )
}

/** '#rrggbb' or 'rgba(r,g,b,a)' as a hex and an opacity, for the colour wells. */
function splitColour(c: string): { hex: string; alpha: number } {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (h) {
    const x = h[1]!.length === 3 ? [...h[1]!].map((d) => d + d).join('') : h[1]!
    return { hex: `#${x.toLowerCase()}`, alpha: 1 }
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(c.trim())
  if (m) {
    const hex = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')
    return { hex: `#${hex}`, alpha: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))) }
  }
  return { hex: '#000000', alpha: 1 }
}

function joinColour(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(alpha * 100) / 100})`
}

/** m:ss.t, short enough to sit beside a caption in a narrow column. */
function shortTime(s: number): string {
  const t = Math.max(0, s)
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

const toast = (message: string, kind?: 'info' | 'success' | 'danger'): void => useToasts.getState().show(message, kind)

// ---------------------------------------------------------------------------
// Create

function JobCard() {
  const status = useTranscribe((s) => s.status)
  const pct = useTranscribe((s) => s.pct)
  const downloading = useTranscribe((s) => s.downloading)
  const queue = useTranscribe((s) => s.queue)
  const cancel = useTranscribe((s) => s.cancel)
  const progress = captionJobProgress(status, pct, queue)
  return (
    <div data-testid="captions-job" role="status" className="rounded-overlay border border-border bg-bg-elevated p-2.5">
      <div className="flex items-center gap-2 text-ui-sm text-text-primary">
        {/* In-progress work is an ember state, not an accent state. */}
        <Loader2 size={13} strokeWidth={2} aria-hidden className="shrink-0 animate-spin text-ember" />
        <span className="min-w-0 truncate">{captionJobLabel(status, downloading)}</span>
        {queue && (
          <span data-testid="captions-job-queue" className="ml-auto shrink-0 font-numeric text-text-secondary">
            clip {queue.index} of {queue.total}
          </span>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-bg-input">
        {progress === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-ember/70" />
        ) : (
          <div
            className="h-full rounded-full bg-ember transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </div>
      {cancel && (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" data-testid="captions-job-stop" onClick={cancel}>
            Stop
          </Button>
        </div>
      )}
    </div>
  )
}

function CreatePart({ onScript }: { onScript: (mode: ScriptMode) => void }) {
  const [open, toggle] = useFold('create', true)
  const selection = useStore((s) => s.ui.selection)
  const project = useStore((s) => s.project)
  const status = useTranscribe((s) => s.status)
  const saved = useCaptionStyles((s) => s.saved)
  const defaultId = useCaptionStyles((s) => s.defaultId)
  const [language, setLanguage] = useState<CaptionLanguage>(getCaptionLanguage)
  const [emphasis, setEmphasis] = useState(getCaptionEmphasis)

  // Everything below asks the doors themselves, never a copy of their rules:
  // the count on a button is the count that gets captioned. The doors read the
  // live store, so each answer is worked out again whenever the project changes.
  const targets = useMemo(() => {
    void project
    return selection.length > 0 ? captionTargets(selection) : []
  }, [selection, project])
  const every = useMemo(() => {
    void project
    return audibleClips()
  }, [project])
  const hasVoice = useMemo(() => {
    void project
    return voiceoverClipId() !== null
  }, [project])
  const selectedSound = useMemo(() => {
    const seq = activeSequence(project)
    return seq.tracks.some((t) => t.clips.some((c) => selection.includes(c.id) && !c.title && project.assets[c.assetId]?.hasAudio))
  }, [selection, project])
  const styles = [...BUILTIN_CAPTION_STYLES, ...saved]
  const busy = status !== 'idle'

  const n = targets.length
  const fromSelection = n > 0 || selectedSound
  const primaryLabel = n > 1 ? `Caption ${n} selected clips` : fromSelection ? 'Caption this clip' : 'Caption the voiceover'
  const primaryTitle = fromSelection
    ? 'Listen to what you selected and caption it, in one undo step'
    : 'Nothing selected, so this captions the voiceover under the playhead, or the first one on the timeline'

  const runPrimary = (): void => {
    if (fromSelection) {
      void captionTheseClips(selection)
      return
    }
    const id = voiceoverClipId()
    if (id) void autoCaptionFromClip(id)
  }

  const skipped = every.skippedLocked + every.skippedMusic + every.skippedSilent + every.skippedReversed
  const hint =
    every.targets.length === 0
      ? skipped > 0
        ? 'The clips with sound are locked, muted, backwards or on a music track, so there is nothing to caption yet.'
        : 'Add a clip with sound first.'
      : `Caption every clip hears all ${every.targets.length} with sound, onto one Captions track.`

  return (
    <Part
      title="Create"
      testId="captions-create"
      open={open}
      onToggle={toggle}
      aside={!open && busy ? <Loader2 size={12} strokeWidth={2} className="animate-spin text-ember" aria-label="Captioning" /> : null}
    >
      {busy ? (
        <JobCard />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="primary"
            data-testid="captions-auto"
            title={primaryTitle}
            disabled={!fromSelection && !hasVoice}
            onClick={runPrimary}
            className="justify-center"
          >
            <Sparkles size={14} strokeWidth={1.75} />
            {primaryLabel}
          </Button>
          <Button
            variant="secondary"
            data-testid="captions-auto-all"
            disabled={every.targets.length === 0}
            onClick={() => void autoCaptionEveryClip()}
            className="justify-center"
          >
            <Layers size={14} strokeWidth={1.5} />
            Caption every clip
          </Button>
        </div>
      )}
      <p data-testid="captions-hint" className="text-[11px] leading-snug text-text-muted">
        {hint}
      </p>
      <div className="flex flex-col gap-1">
        <Row label="Style" labelTitle="The caption style every new caption gets">
          <select
            aria-label="Style for new captions"
            data-testid="captions-default-style"
            value={defaultId}
            onChange={(e) => setDefaultCaptionStyle(e.target.value)}
            className={`${selectCls} w-full max-w-[150px]`}
          >
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Language" labelTitle="The language you speak in the clip">
          <select
            aria-label="Caption language"
            data-testid="captions-language"
            value={language}
            onChange={(e) => {
              const v = e.target.value as CaptionLanguage
              setLanguage(v)
              setCaptionLanguage(v) // persists; every caption door reads it
            }}
            className={`${selectCls} w-full max-w-[150px]`}
          >
            {CAPTION_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Highlight the key word"
          labelFor="captions-emphasis"
          labelTitle="Colours the one word you leaned on in a phrase, in the style's highlight colour. Off until you turn it on."
          lead={
            <input
              id="captions-emphasis"
              type="checkbox"
              aria-label="Highlight the key word"
              data-testid="captions-emphasis"
              checked={emphasis}
              onChange={(e) => {
                setEmphasis(e.target.checked)
                setCaptionEmphasis(e.target.checked) // persists; every caption door reads it
              }}
              className="shrink-0 accent-accent"
            />
          }
        />
      </div>
      <div className="flex items-center gap-1 text-[11px] text-text-muted">
        <span>From a script:</span>
        <button
          type="button"
          data-testid="captions-paste"
          disabled={busy}
          onClick={() => onScript('paste')}
          className="cursor-default rounded-field px-1 text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-40"
        >
          Paste a transcript
        </button>
        <span aria-hidden>·</span>
        <button
          type="button"
          data-testid="captions-tap"
          disabled={busy}
          onClick={() => onScript('tap')}
          className="cursor-default rounded-field px-1 text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-40"
        >
          Tap to time
        </button>
      </div>
    </Part>
  )
}

// ---------------------------------------------------------------------------
// Style

/** What the editor holds: a style's look written out in full at this sequence's size. */
interface Draft {
  look: CaptionLook
  shape: CaptionShape
  emphasisColor: string
  appearance?: AppearanceSpec
  effects?: EffectInstance[]
}

function draftOf(style: CaptionStyle, seqHeight: number): Draft {
  return {
    look: lookOfTitle(captionDefFor(style, '', seqHeight)),
    shape: style.shape,
    emphasisColor: style.emphasisColor,
    ...(style.appearance ? { appearance: style.appearance } : {}),
    ...(style.effects?.length ? { effects: style.effects } : {}),
  }
}

/** A style's fields as a new style is made of them: everything but who it is. */
const fieldsOf = (s: CaptionStyle): CaptionStyleDraft => ({
  name: s.name,
  look: s.look,
  refHeight: s.refHeight,
  shape: s.shape,
  emphasisColor: s.emphasisColor,
  appearance: s.appearance,
  effects: s.effects,
})

/** The edited style, as the thing to save or put on captions. Sizes are this sequence's. */
function styleOf(base: CaptionStyle, d: Draft, seqHeight: number): CaptionStyle {
  return {
    ...base,
    look: d.look,
    refHeight: seqHeight,
    shape: d.shape,
    emphasisColor: d.emphasisColor,
    appearance: d.appearance,
    effects: d.effects,
  }
}

/**
 * A caption in the look being edited, drawn by the browser. Close, not exact:
 * the real thing is rasterised for the video, and this is only here so a change
 * shows before it is put on anything.
 */
function StylePreview({ draft, seqHeight }: { draft: Draft; seqHeight: number }) {
  const look = draft.look
  const scale = 26 / Math.max(1, (105 / 1920) * seqHeight)
  const size = Math.max(10, Math.min(34, (look.fontSizePx ?? 60) * scale))
  const stroke = look.outline ? Math.max(0.5, Math.min(4, look.outline.widthPx * scale * 0.5)) : 0
  const shadow = look.shadow
    ? `${Math.round(look.shadow.dx * scale)}px ${Math.round(look.shadow.dy * scale)}px ${Math.round(look.shadow.blurPx * scale)}px ${look.shadow.color}`
    : 'none'
  const word = (text: string, color?: string) => (
    <span style={{ color: color ?? look.color ?? '#ffffff' }}>{text}</span>
  )
  return (
    <div
      data-testid="caption-style-preview"
      aria-hidden
      className="flex h-[76px] items-center justify-center overflow-hidden rounded-overlay border border-border bg-[linear-gradient(135deg,#2a3d4f_0%,#16202b_55%,#3b2a1f_100%)] px-2"
    >
      <span
        style={{
          fontFamily: look.fontFamily ?? CAPTION_FONT_STACK,
          fontSize: size,
          fontWeight: look.bold ? 800 : 400,
          fontStyle: look.italic ? 'italic' : 'normal',
          lineHeight: 1.1,
          textTransform: look.textCase === 'upper' ? 'uppercase' : look.textCase === 'lower' ? 'lowercase' : 'none',
          WebkitTextStroke: stroke ? `${stroke}px ${look.outline!.color}` : undefined,
          paintOrder: 'stroke fill',
          textShadow: shadow,
          background: look.box ? look.box.color : undefined,
          padding: look.box ? `${Math.max(2, look.box.paddingPx * scale)}px ${Math.max(4, look.box.paddingPx * scale * 1.4)}px` : undefined,
          borderRadius: look.box ? Math.max(0, look.box.radiusPx * scale) : undefined, // corner-is-content: the caption's own box, at its real radius
          textAlign: 'center',
        }}
      >
        {word('this is ')}
        {word('the', draft.emphasisColor)}
        {word(' caption')}
      </span>
    </div>
  )
}

/** The delete button that takes two clicks, like every other delete in the app. */
function DeleteStyleButton({ style, onDeleted }: { style: CaptionStyle; onDeleted: () => void }) {
  const [armed, setArmed] = useState(false)
  const armRef = useRef<ArmedDelete | null>(null)
  if (!armRef.current) armRef.current = createArmedDelete({ onChange: setArmed })
  const arm = armRef.current
  useEffect(() => () => arm.dispose(), [arm])
  return (
    <IconButton
      size="compact"
      label={armed ? `Click again to delete "${style.name}"` : `Delete "${style.name}"`}
      data-testid="caption-style-delete"
      data-armed={armed ? 'true' : undefined}
      onClick={() => {
        if (arm.press() !== 'confirmed') return
        if (deleteCaptionStyle(style.id)) {
          toast(`Deleted "${style.name}"`)
          onDeleted()
        }
      }}
      onBlur={() => arm.disarm()}
      className={armed ? 'bg-danger/20 text-danger hover:bg-danger/30 hover:text-danger' : ''}
    >
      <Trash2 size={14} strokeWidth={1.5} />
    </IconButton>
  )
}

function StyleEditor({ style, seqHeight, onPick }: { style: CaptionStyle; seqHeight: number; onPick: (id: string) => void }) {
  const baseline = useMemo(() => draftOf(style, seqHeight), [style, seqHeight])
  const [draft, setDraft] = useState(baseline)
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const selection = useStore((s) => s.ui.selection)
  const project = useStore((s) => s.project)
  const defaultId = useCaptionStyles((s) => s.defaultId)
  const isDefault = defaultId === style.id

  const seq = activeSequence(project)
  const selectedTitles = useMemo(
    () => seq.tracks.flatMap((t) => t.clips).filter((c) => c.title && selection.includes(c.id)).map((c) => c.id),
    [seq, selection],
  )
  const captionCount = useMemo(() => captionsOn(seq).length, [seq])

  const look = draft.look
  const setLook = (patch: CaptionLook): void => setDraft((d) => ({ ...d, look: { ...d.look, ...patch } }))
  const setShape = (patch: Partial<CaptionShape>): void => setDraft((d) => ({ ...d, shape: cleanShape({ ...d.shape, ...patch }) }))
  const setAppearance = (patch: AppearanceSpec): void =>
    setDraft((d) => {
      const next = { ...d.appearance, ...patch }
      if (!next.in) delete next.in
      if (!next.out) delete next.out
      const empty = !next.in && !next.out
      const out: Draft = { ...d }
      if (empty) delete out.appearance
      else out.appearance = next
      return out
    })

  // House sizes at this sequence: what a fresh outline, shadow or box starts at.
  const k = seqHeight / 1920
  const px = (v: number): number => Math.max(1, Math.round(v * k))

  const edited = (): CaptionStyle => styleOf(style, draft, seqHeight)

  const saveNew = async (): Promise<void> => {
    const name = await askForName({
      title: 'Name this caption style',
      confirmLabel: 'Save',
      initial: uniqueStyleName(style.builtin ? 'My caption style' : `${style.name} copy`),
      maxLength: 40,
      validate: (v) => (v.trim() ? null : 'Give it a name'),
    })
    if (!name) return
    const saved = saveNewCaptionStyle({ ...fieldsOf(edited()), name })
    toast(`Saved "${saved.name}". Star it to use it for new captions`, 'success')
    onPick(saved.id)
  }

  const update = (): void => {
    const fields: Partial<CaptionStyleDraft> = fieldsOf(edited())
    delete fields.name
    if (updateCaptionStyle(style.id, fields)) toast(`Updated "${style.name}"`, 'success')
  }

  const rename = async (): Promise<void> => {
    const name = await askForName({
      title: 'Rename caption style',
      confirmLabel: 'Rename',
      initial: style.name,
      maxLength: 40,
      validate: (v) => (v.trim() ? null : 'Give it a name'),
    })
    if (name && name !== style.name) renameCaptionStyle(style.id, name)
  }

  const apply = (ids?: string[]): void => {
    const s = edited()
    const { styled, recut, locked } = applyCaptionStyle(s, ids)
    if (styled === 0 && locked > 0) {
      toast('Those captions are on a locked track, so nothing was changed', 'danger')
      return
    }
    if (styled === 0) return
    toast(
      [
        `"${s.name}" on ${styled} caption${styled === 1 ? '' : 's'}`,
        recut ? 'cut again at its length' : '',
        locked > 0 ? `${locked} on a locked track left alone` : '',
      ]
        .filter(Boolean)
        .join(', '),
      'success',
    )
  }

  const shape = draft.shape
  const box = look.box ? splitColour(look.box.color) : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <IconButton
          size="compact"
          label={isDefault ? 'New captions use this style' : 'Use this style for new captions'}
          active={isDefault}
          data-testid="caption-style-default"
          onClick={() => {
            setDefaultCaptionStyle(style.id)
            if (!isDefault) toast(`New captions now use "${style.name}"`)
          }}
        >
          <Star size={14} strokeWidth={1.5} className={isDefault ? 'fill-current' : ''} />
        </IconButton>
        <select
          aria-label="Caption style to edit"
          data-testid="caption-style-select"
          value={style.id}
          onChange={(e) => onPick(e.target.value)}
          className={`${selectCls} flex-1`}
        >
          {allCaptionStyles().map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.id === defaultId ? ' (new captions)' : ''}
            </option>
          ))}
        </select>
        {!style.builtin && (
          <>
            <IconButton size="compact" label={`Rename "${style.name}"`} data-testid="caption-style-rename" onClick={() => void rename()}>
              <Pencil size={13} strokeWidth={1.5} />
            </IconButton>
            <DeleteStyleButton style={style} onDeleted={() => onPick(useCaptionStyles.getState().defaultId)} />
          </>
        )}
      </div>

      <StylePreview draft={draft} seqHeight={seqHeight} />

      <div className="flex flex-col gap-1">
        <Row label="Font">
          <select
            aria-label="Caption font"
            data-testid="caption-style-font"
            value={look.fontFamily ?? CAPTION_FONT_STACK}
            onChange={(e) => {
              // The face is fetched when he picks it, as in the Inspector.
              void ensureTitleFont(document.fonts, e.target.value)
              setLook({ fontFamily: e.target.value })
            }}
            className={`${selectCls} w-full max-w-[150px]`}
          >
            {[...new Set(TITLE_FONT_OPTIONS.map((f) => f.group))].map((g) => (
              <optgroup key={g} label={g}>
                {TITLE_FONT_OPTIONS.filter((f) => f.group === g).map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            ))}
            {look.fontFamily && !TITLE_FONT_OPTIONS.some((f) => f.value === look.fontFamily) && (
              <option value={look.fontFamily}>Custom</option>
            )}
          </select>
        </Row>
        <Row label="Size" labelTitle="Text size, in this video's pixels">
          <ScrubField
            value={look.fontSizePx ?? px(105)}
            spec={{ min: 8, max: 400, step: 1, sens: 0.5 }}
            testId="caption-style-size"
            ariaLabel="Caption size"
            onCommit={(v) => setLook({ fontSizePx: v })}
          />
        </Row>
        <Row label="Weight, case">
          <div className="flex items-center gap-0.5">
            <IconButton size="compact" label="Bold" active={!!look.bold} onClick={() => setLook({ bold: !look.bold })}>
              <Bold size={14} strokeWidth={1.5} />
            </IconButton>
            <IconButton size="compact" label="Italic" active={!!look.italic} onClick={() => setLook({ italic: !look.italic })}>
              <Italic size={14} strokeWidth={1.5} />
            </IconButton>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <IconButton
              size="compact"
              label="As spoken"
              active={!look.textCase}
              data-testid="caption-style-case-asis"
              onClick={() => setLook({ textCase: null })}
            >
              <CaseSensitive size={15} strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="compact"
              label="lowercase"
              active={look.textCase === 'lower'}
              data-testid="caption-style-case-lower"
              onClick={() => setLook({ textCase: 'lower' })}
            >
              <CaseLower size={15} strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="compact"
              label="UPPERCASE"
              active={look.textCase === 'upper'}
              data-testid="caption-style-case-upper"
              onClick={() => setLook({ textCase: 'upper' })}
            >
              <CaseUpper size={15} strokeWidth={1.5} />
            </IconButton>
          </div>
        </Row>
        <Row label="Colour">
          {['#ffffff', '#FFD400', '#3B7DFF'].map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Colour ${hex}`}
              title={hex}
              onClick={() => setLook({ color: hex })}
              className={`h-5 w-5 shrink-0 cursor-default rounded-field border transition-transform duration-[120ms] hover:scale-110 ${
                (look.color ?? '').toLowerCase() === hex.toLowerCase() ? 'border-accent' : 'border-border-strong'
              }`}
              style={{ backgroundColor: hex }}
            />
          ))}
          <ColourWell value={look.color ?? '#ffffff'} onChange={(hex) => setLook({ color: hex })} label="Caption colour" testId="caption-style-color" />
        </Row>
        <Row label="Highlight" labelTitle="The colour of the key word, when Highlight the key word is on">
          <ColourWell
            value={draft.emphasisColor}
            onChange={(hex) => setDraft((d) => ({ ...d, emphasisColor: hex }))}
            label="Highlight colour"
            testId="caption-style-highlight"
          />
        </Row>
        <Row
          label="Outline"
          labelFor="caption-style-outline"
          lead={
            <input
              id="caption-style-outline"
              type="checkbox"
              aria-label="Outline"
              data-testid="caption-style-outline"
              checked={!!look.outline}
              onChange={(e) => setLook({ outline: e.target.checked ? { color: '#000000', widthPx: px(15) } : null })}
              className="shrink-0 accent-accent"
            />
          }
        >
          {look.outline && (
            <>
              <ColourWell
                value={look.outline.color}
                onChange={(hex) => setLook({ outline: { ...look.outline!, color: hex } })}
                label="Outline colour"
                testId="caption-style-outline-color"
              />
              <ScrubField
                value={look.outline.widthPx}
                spec={{ min: 0, max: 80, step: 1, sens: 0.2 }}
                testId="caption-style-outline-width"
                ariaLabel="Outline width"
                onCommit={(v) => setLook({ outline: { ...look.outline!, widthPx: v } })}
              />
            </>
          )}
        </Row>
        <Row
          label="Shadow"
          labelFor="caption-style-shadow"
          lead={
            <input
              id="caption-style-shadow"
              type="checkbox"
              aria-label="Shadow"
              data-testid="caption-style-shadow"
              checked={!!look.shadow}
              onChange={(e) =>
                setLook({ shadow: e.target.checked ? { color: 'rgba(0,0,0,0.4)', blurPx: px(6), dx: px(6), dy: px(6) } : null })
              }
              className="shrink-0 accent-accent"
            />
          }
        >
          {look.shadow && (
            <ScrubField
              value={look.shadow.blurPx}
              spec={{ min: 0, max: 120, step: 1, sens: 0.2 }}
              testId="caption-style-shadow-blur"
              ariaLabel="Shadow softness"
              onCommit={(v) => setLook({ shadow: { ...look.shadow!, blurPx: v } })}
            />
          )}
        </Row>
        <Row
          label="Background"
          labelFor="caption-style-box"
          labelTitle="A box behind the words"
          lead={
            <input
              id="caption-style-box"
              type="checkbox"
              aria-label="Background box"
              data-testid="caption-style-box"
              checked={!!look.box}
              onChange={(e) => setLook({ box: e.target.checked ? { color: 'rgba(0,0,0,0.6)', paddingPx: px(18), radiusPx: px(8) } : null })}
              className="shrink-0 accent-accent"
            />
          }
        >
          {look.box && box && (
            <>
              <ColourWell
                value={look.box.color}
                onChange={(hex) => setLook({ box: { ...look.box!, color: joinColour(hex, box.alpha) } })}
                label="Background colour"
                testId="caption-style-box-color"
              />
              <ScrubField
                value={Math.round(box.alpha * 100)}
                spec={{ min: 0, max: 100, step: 1, sens: 0.5 }}
                testId="caption-style-box-opacity"
                ariaLabel="Background opacity, percent"
                onCommit={(v) => setLook({ box: { ...look.box!, color: joinColour(box.hex, v / 100) } })}
              />
            </>
          )}
        </Row>
        <Row label="Position">
          <div className="flex items-center gap-0.5 rounded-field bg-bg-input p-0.5">
            {(
              [
                { v: 'top', label: 'Top', icon: AlignStartVertical },
                { v: 'middle', label: 'Middle', icon: AlignVerticalJustifyCenter },
                { v: 'bottom', label: 'Bottom', icon: AlignEndVertical },
              ] as const
            ).map(({ v, label, icon: Icon }) => (
              <IconButton
                key={v}
                size="compact"
                label={label}
                active={(look.vAlign ?? 'middle') === v}
                data-testid={`caption-style-pos-${v}`}
                onClick={() => setLook({ vAlign: v })}
              >
                <Icon size={14} strokeWidth={1.5} />
              </IconButton>
            ))}
          </div>
        </Row>
        <Row
          label="Nudge"
          labelTitle="Move it up (less) or down (more), in this video's pixels"
          onReset={() => setLook({ offsetYPx: 0 })}
          resetLabel="Back to the line"
        >
          <ScrubField
            value={look.offsetYPx ?? 0}
            spec={{ min: -2000, max: 2000, step: 1, sens: 1 }}
            testId="caption-style-offset"
            ariaLabel="Nudge up or down"
            onCommit={(v) => setLook({ offsetYPx: v })}
          />
        </Row>
        <Row label="Comes in">
          <select
            aria-label="How a caption comes in"
            data-testid="caption-style-in"
            value={draft.appearance?.in ?? ''}
            onChange={(e) => setAppearance({ in: e.target.value || undefined })}
            className={`${selectCls} w-full max-w-[150px]`}
          >
            <option value="">Hard cut</option>
            {ENTRANCE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Goes out">
          <select
            aria-label="How a caption goes out"
            data-testid="caption-style-out"
            value={draft.appearance?.out ?? ''}
            onChange={(e) => setAppearance({ out: e.target.value || undefined })}
            className={`${selectCls} w-full max-w-[150px]`}
          >
            <option value="">Hard cut</option>
            {EXIT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="h-px bg-border" />
      <div className="flex flex-col gap-1" data-testid="caption-style-length">
        <Row label="Length" labelTitle="Auto aims every caption at the same time on screen. Fixed fills each one up to your limits">
          <Choice
            value={shape.length}
            testId="caption-style-length"
            onChange={(v) => setShape({ length: v })}
            options={[
              { value: 'auto', label: 'Auto', title: 'Even blocks timed to the voice, the measured look' },
              { value: 'fixed', label: 'Fixed', title: 'Up to the words and characters you set' },
            ]}
          />
        </Row>
        {shape.length === 'fixed' && (
          <>
            <Row label="Words per caption" labelTitle="The most words one caption may hold">
              <ScrubField
                value={shape.maxWords}
                spec={{ min: SHAPE_LIMITS.maxWords.min, max: SHAPE_LIMITS.maxWords.max, step: 1, sens: 0.05 }}
                testId="caption-style-words"
                ariaLabel="Most words in one caption"
                onCommit={(v) => setShape({ maxWords: v })}
              />
            </Row>
            <Row label="Letters per line" labelTitle="The most characters on one line, spaces included">
              <ScrubField
                value={shape.charsPerLine}
                spec={{ min: SHAPE_LIMITS.charsPerLine.min, max: SHAPE_LIMITS.charsPerLine.max, step: 1, sens: 0.1 }}
                testId="caption-style-chars"
                ariaLabel="Most characters on one line"
                onCommit={(v) => setShape({ charsPerLine: v })}
              />
            </Row>
            <Row label="Lines">
              <Choice
                value={shape.lines}
                testId="caption-style-lines"
                onChange={(v) => setShape({ lines: v })}
                options={[
                  { value: 1, label: '1', title: 'One line' },
                  { value: 2, label: '2', title: 'Two balanced lines' },
                ]}
              />
            </Row>
          </>
        )}
        <Row label="Shortest time" labelTitle="No caption leaves the screen sooner than this, in seconds">
          <ScrubField
            value={shape.minDurS}
            spec={{ min: SHAPE_LIMITS.minDurS.min, max: SHAPE_LIMITS.minDurS.max, step: 0.05, sens: 0.005 }}
            testId="caption-style-mindur"
            ariaLabel="Shortest time on screen, seconds"
            onCommit={(v) => setShape({ minDurS: v })}
          />
        </Row>
        <Row label="Gap between" labelTitle="Blank frames between one caption and the next. 0 hands straight over">
          <ScrubField
            value={shape.gapFrames}
            spec={{ min: SHAPE_LIMITS.gapFrames.min, max: SHAPE_LIMITS.gapFrames.max, step: 1, sens: 0.05 }}
            testId="caption-style-gap"
            ariaLabel="Gap between captions, frames"
            onCommit={(v) => setShape({ gapFrames: v })}
          />
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {dirty && !style.builtin && (
          <Button variant="primary" data-testid="caption-style-update" onClick={update}>
            Update style
          </Button>
        )}
        <Button variant={dirty && style.builtin ? 'primary' : 'secondary'} data-testid="caption-style-save-new" onClick={() => void saveNew()}>
          <Plus size={14} strokeWidth={1.5} />
          Save as new
        </Button>
        {dirty && (
          <Button variant="ghost" data-testid="caption-style-revert" onClick={() => setDraft(baseline)}>
            Revert
          </Button>
        )}
      </div>
      {dirty && style.builtin && (
        <p className="text-[11px] leading-snug text-text-muted">Built in styles stay as they are. Save your changes as a new style.</p>
      )}

      <div className="flex flex-col gap-1.5 rounded-overlay bg-bg-elevated p-2">
        <span className="text-[11px] text-text-secondary">Put this look on captions you already have</span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            data-testid="caption-style-apply-selected"
            disabled={selectedTitles.length === 0}
            title={selectedTitles.length === 0 ? 'Select some captions on the timeline first' : undefined}
            onClick={() => apply(selectedTitles)}
            className="flex-1 justify-center"
          >
            {selectedTitles.length > 0 ? `Selected (${selectedTitles.length})` : 'Selected'}
          </Button>
          <Button
            variant="secondary"
            data-testid="caption-style-apply-all"
            disabled={captionCount === 0}
            onClick={() => apply()}
            className="flex-1 justify-center"
          >
            {captionCount > 0 ? `All (${captionCount})` : 'All'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StylePart() {
  const [open, toggle] = useFold('style', false)
  const saved = useCaptionStyles((s) => s.saved)
  const defaultId = useCaptionStyles((s) => s.defaultId)
  const seqHeight = useStore((s) => activeSequence(s.project).height)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Read off the subscribed list, so an update, a rename or a delete redraws this.
  const all = [...BUILTIN_CAPTION_STYLES, ...saved]
  const style = all.find((s) => s.id === editingId) ?? all.find((s) => s.id === defaultId) ?? BUILTIN_CAPTION_STYLES[0]!
  return (
    <Part
      title="Style"
      testId="captions-style"
      open={open}
      onToggle={toggle}
      aside={
        <span
          data-testid="captions-style-current"
          title="The style new captions get"
          className="min-w-0 truncate rounded-field bg-bg-input px-1.5 py-0.5 text-[11px] text-text-secondary"
        >
          {defaultCaptionStyle().name}
        </span>
      }
    >
      {/* Keyed on the style and the frame height, so picking another style or
          saving this one starts the editor fresh from what is stored. */}
      <StyleEditor
        key={`${style.id}:${style.updatedAt}:${seqHeight}`}
        style={style}
        seqHeight={seqHeight}
        onPick={setEditingId}
      />
    </Part>
  )
}

// ---------------------------------------------------------------------------
// Captions

const CaptionRow = memo(function CaptionRow({
  clip,
  active,
  selected,
  locked,
  onJump,
}: {
  clip: Clip
  active: boolean
  selected: boolean
  locked: boolean
  onJump: (clip: Clip) => void
}) {
  const text = (clip.title?.text ?? '').replace(/\s*\n\s*/g, ' ')
  return (
    <div
      data-testid="caption-row"
      data-id={clip.id}
      data-active={active || undefined}
      onMouseDown={(e) => {
        // A click on the row (not in the text) jumps there.
        if ((e.target as HTMLElement).tagName !== 'INPUT') onJump(clip)
      }}
      className={`relative grid cursor-default grid-cols-[44px_minmax(0,1fr)] items-center gap-1.5 py-0.5 pl-3 pr-2 transition-colors duration-[120ms] ${
        active ? 'bg-accent-quiet' : selected ? 'bg-bg-elevated' : 'hover:bg-bg-elevated'
      }`}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <span className={`font-mono text-[11px] tabular-nums ${active ? 'text-accent' : 'text-text-muted'}`}>{shortTime(clip.startS)}</span>
      <input
        // Keyed on the text so an undo or a restyle shows here at once.
        key={text}
        type="text"
        data-testid="caption-row-text"
        aria-label={`Caption at ${shortTime(clip.startS)}`}
        defaultValue={text}
        readOnly={locked}
        title={locked ? 'This caption is on a locked track' : undefined}
        onFocus={() => onJump(clip)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            e.currentTarget.value = text
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const typed = e.currentTarget.value
          if (typed.trim() === text.trim()) return
          if (!setCaptionText(clip.id, typed)) e.currentTarget.value = text
        }}
        className="h-6 min-w-0 rounded-field bg-transparent px-1.5 text-ui-sm text-text-primary transition-colors duration-[120ms] hover:bg-bg-input focus:bg-bg-input focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  )
})

function CaptionList() {
  const project = useStore((s) => s.project)
  const playheadS = useStore((s) => s.ui.playheadS)
  const playing = useStore((s) => s.ui.playing)
  const selection = useStore((s) => s.ui.selection)
  const seq = activeSequence(project)
  const items = useMemo(() => captionsOn(seq), [seq])
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (q ? items.filter(({ clip }) => (clip.title?.text ?? '').toLowerCase().replace(/\s+/g, ' ').includes(q)) : items),
    [items, q],
  )
  const selected = useMemo(() => new Set(selection), [selection])
  const listRef = useRef<HTMLDivElement>(null)

  // The caption on screen right now. Captions never overlap on a track, so the
  // last one that has started is the only candidate.
  const activeId = useMemo(() => {
    let lo = 0
    let hi = items.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (items[mid]!.clip.startS <= playheadS + 1e-6) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const hit = found >= 0 ? items[found]!.clip : undefined
    return hit && playheadS < clipEndS(hit) ? hit.id : null
  }, [items, playheadS])

  // While it plays, the list follows, unless he is reading or typing in it.
  useEffect(() => {
    if (!playing || !activeId) return
    const list = listRef.current
    if (!list || list.matches(':hover') || list.contains(document.activeElement)) return
    list.querySelector(`[data-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [playing, activeId])

  const onJump = useCallback((clip: Clip) => {
    useStore.getState().setUI({ playheadS: clip.startS, selection: [clip.id] })
  }, [])

  return (
    <section data-testid="captions-list" className="flex min-h-[140px] flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-3">
        <SectionLabel>Captions</SectionLabel>
        <span data-testid="captions-count" className="font-numeric text-[11px] text-text-muted">
          {q ? `${shown.length} of ${items.length}` : items.length}
        </span>
      </div>
      {items.length > 0 && (
        <div className="shrink-0 px-3 pb-2">
          <label className="flex h-6 items-center gap-1.5 rounded-field bg-bg-input px-2 focus-within:ring-1 focus-within:ring-accent">
            <Search size={12} strokeWidth={1.75} className="shrink-0 text-text-muted" aria-hidden />
            <input
              type="search"
              data-testid="captions-search"
              aria-label="Search captions"
              placeholder="Search captions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
              className="h-full min-w-0 flex-1 bg-transparent text-ui-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
          </label>
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-2">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
            <Sparkles size={18} strokeWidth={1.5} className="text-text-muted" aria-hidden />
            <p className="text-ui-sm text-text-secondary">No captions yet</p>
            <p className="text-[11px] leading-snug text-text-muted">
              Caption a clip above, and every caption shows up here to read, fix and jump to.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-text-muted">No caption says that.</p>
        ) : (
          shown.map(({ clip, track }) => (
            <CaptionRow
              key={clip.id}
              clip={clip}
              active={clip.id === activeId}
              selected={selected.has(clip.id)}
              locked={track.locked}
              onJump={onJump}
            />
          ))
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

export function CaptionsTab() {
  const [script, setScript] = useState<ScriptMode | null>(null)
  return (
    <div data-testid="captions-tab" className="flex min-h-0 flex-1 flex-col">
      {/* Create and Style share the top and scroll together; the list keeps the
          rest of the column so it is never pushed off the bottom. */}
      <div className="max-h-[64%] shrink-0 overflow-y-auto border-b border-border [&>section:last-child]:border-b-0">
        <CreatePart onScript={setScript} />
        <StylePart />
      </div>
      <CaptionList />
      {script && <CaptionsDialog initialMode={script} onClose={() => setScript(null)} />}
    </div>
  )
}
