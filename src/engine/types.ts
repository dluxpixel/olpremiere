// REEL document model. Pure data — everything here must survive structuredClone
// (IndexedDB persistence), so no getters, no class instances, no functions.

export type Id = string

export interface Project {
  id: Id
  name: string
  createdAt: number
  updatedAt: number
  assets: Record<Id, MediaAsset>
  sequences: Record<Id, Sequence>
  activeSequenceId: Id
  settings: { fps: number; width: number; height: number; sampleRate: number }
}

/** An imported source file. */
export interface MediaAsset {
  id: Id
  name: string
  kind: 'video' | 'audio' | 'image'
  /** IndexedDB key for the raw bytes. */
  blobKey: string
  /** Source duration in seconds (0 for stills). */
  durationS: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  hasVideo: boolean
  /** IndexedDB key of the cached poster frame. */
  thumbnailKey?: string
  codec?: string
}

export interface Sequence {
  id: Id
  name: string
  fps: number
  width: number
  height: number
  sampleRate: number
  /** Derived: end of the last clip. Kept in sync by timeline operations. */
  durationS: number
  /**
   * Track order within each kind: index 0 is the BOTTOM of the stack;
   * video renders bottom→top. Video and audio tracks share this array.
   */
  tracks: Track[]
  markers: Marker[]
  /**
   * Work area (spec §5.6, I / O). Both optional and independent: an in point
   * alone means "to the end", an out point alone "from the start". Always read
   * them through engine/workArea.ts, which normalises inverted, out-of-bounds,
   * and degenerate ranges rather than letting an export render zero frames.
   */
  inPointS?: number
  outPointS?: number
}

export interface Track {
  id: Id
  kind: 'video' | 'audio'
  /** "V1", "A1", … */
  name: string
  /** Lane height in px, resizable. */
  height: number
  muted: boolean
  solo: boolean
  locked: boolean
  /** Track fader in dB (0 = unity). Phase 6 audio mixer. */
  volumeDb: number
  /** Stereo pan, −1 (hard left) .. 1 (hard right); 0 = center. Phase 6. */
  pan: number
  /**
   * Loudness equalization: a compressor + makeup gain on the track bus that
   * evens the audio to the chosen degree. Undefined / 'off' = bypass. Applied
   * identically in preview + export.
   */
  autoLevel?: AutoLevel
  /**
   * Auto-duck opt-in (audio tracks): 'voice' drives the duck, 'music' drops by
   * DUCK_DB whenever a voice clip plays (see engine/ducking.ts). Undefined =
   * neither. Applied identically in preview + export.
   */
  audioRole?: 'voice' | 'music'
  /** Sorted by startS; clips never overlap on one track. */
  clips: Clip[]
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay'

/** Per-track loudness equalization strength (Phase 6+). 'off' = bypass. */
export type AutoLevel = 'off' | 'low' | 'medium' | 'high'

export interface Clip {
  id: Id
  assetId: Id
  /** Position on the sequence timeline, seconds. */
  startS: number
  /** Trim into the source asset, seconds. Duration = (outS - inS) / |speed|. */
  inS: number
  outS: number
  /** 1 = normal; negative = reverse (Phase 7). */
  speed: number
  enabled: boolean
  transform: Transform
  opacity: number
  blendMode: BlendMode
  audioGainDb: number
  fadeInS: number
  fadeOutS: number
  effects: EffectInstance[]
  transitionIn?: Transition
  transitionOut?: Transition
  /** Color label. */
  label?: string
  /**
   * Phase 4 animation. Channel name → keyframes, sorted by t, with t RELATIVE
   * to the clip start (0 = clip's first frame). A channel present here
   * overrides its static base (transform/opacity/filters) at render time; a
   * channel absent falls back to the static value. See ANIM_CHANNELS.
   */
  keyframes?: Partial<Record<AnimChannel, Keyframe[]>>
  /** Phase 4 color/blur filters. Neutral (identity) = every field 0 / absent. */
  filters?: ClipFilters
  /** Phase 5 title. When set, this is a generated title clip (assetId is ''). */
  title?: TitleDef
  /**
   * Entrance / exit animation ("how it appears"). A tiny spec that COMPILES to
   * keyframes on transform + opacity channels (see engine/anim/appearance.ts) —
   * kept alongside the compiled keyframes so a single side can be changed and the
   * pair rebuilt deterministically, and so it can be saved as the text default.
   */
  appearance?: AppearanceSpec
  /**
   * Linked-clip group id (Vegas-style A/V link). Clips sharing a linkId move,
   * trim, split, and delete together. A video clip WITH a linkId is video-only
   * (its audio plays from the linked audio-track clip); a video clip WITHOUT a
   * linkId plays its own audio.
   */
  linkId?: Id
}

/** All keyframeable channels. Names are the shared contract across engine + UI. */
export const ANIM_CHANNELS = [
  'posX',
  'posY',
  'scale',
  'rotation',
  'anchorX',
  'anchorY',
  'cropT',
  'cropR',
  'cropB',
  'cropL',
  'opacity',
  'brightness',
  'contrast',
  'saturation',
  'exposure',
  'blur',
  'lift',
  'gamma',
  'gain',
  'temperature',
  'tint',
] as const
export type AnimChannel = (typeof ANIM_CHANNELS)[number]

export interface ClipFilters {
  /** Additive, −1..1 (0 = neutral). */
  brightness?: number
  /** −1..1 (0 = neutral). */
  contrast?: number
  /** −1..1 (0 = neutral; −1 = greyscale). */
  saturation?: number
  /** Stops, out = color * 2^exposure (0 = neutral). */
  exposure?: number
  /** Gaussian blur radius in output px (0 = none). */
  blur?: number
  // --- Color correction (Phase 7), ASC-CDL-style; all neutral at 0. ---
  /** Black point / offset, −1..1 (0 = neutral). */
  lift?: number
  /** Midtone power, −1..1 (0 = neutral; + brightens mids). */
  gamma?: number
  /** Highlight slope, −1..1 (0 = neutral). */
  gain?: number
  /** White balance warm↔cool, −1..1 (0 = neutral; + warmer). */
  temperature?: number
  /** White balance green↔magenta, −1..1 (0 = neutral; + greener). */
  tint?: number
}

export interface Transform {
  x: number
  y: number
  scale: number
  rotationDeg: number
  anchorX: number
  anchorY: number
  crop: { t: number; r: number; b: number; l: number }
}

export type EffectType = string

export interface EffectInstance {
  id: Id
  type: EffectType
  params: Record<string, Keyframeable>
  enabled: boolean
}

/**
 * An effect param is either a plain static number, or an animated param that
 * ALSO carries `value`: the static base to fall back on when its keyframes are
 * removed. Without that base, turning a stopwatch off would silently reset the
 * param to its neutral instead of the value the user set before animating.
 */
export type Keyframeable = number | { value: number; keyframes: Keyframe[] }

export interface Keyframe {
  t: number
  value: number
  ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut'
}

export interface Transition {
  type: string
  durationS: number
}

/**
 * Entrance / exit animation preset selection. Plain data (structuredClone-safe).
 * `in` / `out` are preset ids from engine/anim/appearance.ts; absent = none.
 */
export interface AppearanceSpec {
  /** Entrance preset id (e.g. 'pop', 'fadeIn'). */
  in?: string
  /** Exit preset id (e.g. 'fadeOut', 'zoomOut'). */
  out?: string
  /** Window length per side, seconds. Defaults to DEFAULT_APPEARANCE_DUR. */
  durS?: number
}

export interface Marker {
  id: Id
  t: number
  label: string
  color: string
}

// ---------------------------------------------------------------------------
// Titles (Phase 5). A title clip has `title` set and an empty assetId — it is
// generated, not imported, and rasterized to a texture at render time.

export interface TitleShadow {
  color: string
  blurPx: number
  dx: number
  dy: number
}

/** A stroke drawn around the glyphs (outline). */
export interface TitleOutline {
  color: string
  /** Stroke width in SEQUENCE px (0 = no outline). */
  widthPx: number
}

/** A background rectangle behind the text (lower-third / plain shape). */
export interface TitleBox {
  color: string
  paddingPx: number
  radiusPx: number
}

export interface TitleDef {
  text: string
  fontFamily: string
  /** Font size in SEQUENCE px (relative to the sequence height). */
  fontSizePx: number
  color: string
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  bold: boolean
  italic: boolean
  /**
   * Force letter case at render time (non-destructive — the typed text is kept).
   * Whisper captions come in ALL-CAPS, so 'lower' fixes a whole batch in one
   * click. Undefined = show the text exactly as typed.
   */
  textCase?: 'upper' | 'lower'
  /** Line-height multiplier. */
  lineHeight: number
  /** Position offset from the aligned anchor, in sequence px. */
  offsetXPx: number
  offsetYPx: number
  shadow?: TitleShadow
  outline?: TitleOutline
  box?: TitleBox
}

export function defaultTitleDef(text = 'Title'): TitleDef {
  return {
    text,
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSizePx: 96,
    color: '#ffffff',
    align: 'center',
    vAlign: 'middle',
    bold: true,
    italic: false,
    lineHeight: 1.2,
    offsetXPx: 0,
    offsetYPx: 0,
    shadow: { color: 'rgba(0,0,0,0.6)', blurPx: 12, dx: 0, dy: 4 },
  }
}

/** A title clip: no source asset, a settable duration like a still. */
export function newTitleClip(def: TitleDef, startS: number, durationS = 5): Clip {
  return {
    id: newId(),
    assetId: '',
    startS,
    inS: 0,
    outS: durationS,
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    title: def,
  }
}

export const isTitleClip = (clip: Clip): boolean => clip.title !== undefined

/** A plain clip referencing an imported asset, placed at startS (in-point 0). */
export function newClipFromAsset(asset: MediaAsset, startS: number): Clip {
  return {
    id: newId(),
    assetId: asset.id,
    startS,
    inS: 0,
    outS: asset.durationS || 5, // stills default to 5s
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
  }
}

// ---------------------------------------------------------------------------
// Factories

export const newId = (): Id => crypto.randomUUID()

export const defaultTransform = (): Transform => ({
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  crop: { t: 0, r: 0, b: 0, l: 0 },
})

export function newTrack(kind: Track['kind'], name: string): Track {
  return {
    id: newId(),
    kind,
    name,
    height: kind === 'video' ? 64 : 60,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [],
  }
}

/** Legacy audio-track default before the mixer row existed; bumped on migrate. */
const LEGACY_AUDIO_TRACK_H = 48

/**
 * Fill fields added after a project was first persisted, so loading an older
 * IndexedDB document never yields tracks missing volumeDb/pan (etc.). Pure +
 * structuredClone-safe; returns the SAME object when nothing needed patching so
 * callers can skip a needless store write.
 */
export function migrateProject(p: Project): Project {
  let changed = false
  const sequences: Record<Id, Sequence> = {}
  for (const [id, seq] of Object.entries(p.sequences)) {
    let seqChanged = false
    const tracks = seq.tracks.map((t) => {
      const needsAudio = typeof t.volumeDb !== 'number' || typeof t.pan !== 'number'
      // Give the mixer row room on audio tracks still at the legacy height.
      const needsHeight = t.kind === 'audio' && t.height === LEGACY_AUDIO_TRACK_H
      if (!needsAudio && !needsHeight) return t
      seqChanged = true
      return {
        ...t,
        volumeDb: t.volumeDb ?? 0,
        pan: t.pan ?? 0,
        height: needsHeight ? 60 : t.height,
      }
    })
    if (seqChanged) {
      changed = true
      sequences[id] = { ...seq, tracks }
    } else {
      sequences[id] = seq
    }
  }
  return changed ? { ...p, sequences } : p
}

export function newSequence(name = 'Sequence 1'): Sequence {
  return {
    id: newId(),
    name,
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 0,
    // Array order: V1 (bottom) → V2, then A1 → A2.
    tracks: [newTrack('video', 'V1'), newTrack('video', 'V2'), newTrack('audio', 'A1'), newTrack('audio', 'A2')],
    markers: [],
  }
}

export function newProject(name = 'Untitled Project'): Project {
  const seq = newSequence()
  const now = Date.now()
  return {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    assets: {},
    sequences: { [seq.id]: seq },
    activeSequenceId: seq.id,
    settings: { fps: 30, width: 1920, height: 1080, sampleRate: 48000 },
  }
}

// ---------------------------------------------------------------------------
// Small selectors shared by UI + engine

export const activeSequence = (p: Project): Sequence => p.sequences[p.activeSequenceId]

/** Video tracks bottom→top (V1 first). */
export const videoTracks = (seq: Sequence): Track[] => seq.tracks.filter((t) => t.kind === 'video')

/** Audio tracks top→bottom (A1 first). */
export const audioTracks = (seq: Sequence): Track[] => seq.tracks.filter((t) => t.kind === 'audio')
