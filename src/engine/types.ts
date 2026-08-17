// OL Premiere document model. Pure data: everything here must survive structuredClone
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
  /**
   * When he ARCHIVED this project, if he has. Archived projects are finished
   * work he does not want to delete: they are hidden from the main Projects
   * list and live behind their own button, and they are never loaded to build
   * that list beyond their summary.
   *
   * Optional on purpose. Every project saved before this existed simply has no
   * field, which reads as not archived, so nothing needs migrating.
   */
  archivedAt?: number
  /**
   * Set on work he has parked for LATER: still live, not finished, just not what
   * he is on today. His words: "separate projects that are there in the
   * background that I will work on in the future and projects that I'm working
   * on right now". Absent means it is current work.
   */
  laterAt?: number
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
  /**
   * Fill the empty frame with a blurred copy of the picture instead of black.
   *
   * His ask, 2026-08-14, with a Shorts screenshot: 16:9 gameplay in a 9:16
   * frame leaves bars, and he wants the soft blurred fill everyone uses there.
   * It has to survive a keyframed zoom out: *"It doesn't zoom out into
   * nothingness and blackness. It zooms out to this blur."* So it is a backdrop
   * behind everything, not a letterbox baked onto the clip.
   *
   * A sequence setting, not a clip one, because that is where he asked for the
   * switch: beside the 16:9 / 9:16 / 1:1 picker. One flip per short.
   */
  blurBackground?: boolean
  /**
   * How far past cover-fit the blurred backdrop is grown, before it blurs.
   *
   * His ask, 2026-08-16: *"make it so I can change it each single time."* It was
   * a constant, and a constant is the wrong shape for a number whose only judge
   * is his eye on that particular clip.
   *
   * ⛔ IT IS WHAT KEEPS THE HUD OUT OF THE BAND. Cover-fit alone spans the whole
   * height of a 9:16 frame, so the bottom of a 16:9 source lands in the bottom
   * band, and on gameplay that is the hotbar and the hearts. Undefined means the
   * default (BACKDROP_ZOOM), so every project made before this reads the same.
   */
  blurBackdropZoom?: number
  /**
   * Shutter angle for the motion blur every move gets for free, in degrees.
   *
   * 180 is the film standard and the After Effects default: the shutter is open for
   * half of each frame, so a move smears by half a frame of travel. 0 turns it off
   * entirely. Undefined means the default, so nothing needs migrating.
   *
   * ⛔ IT IS NOT AN EFFECT HE ADDS. The renderer derives the smear from how far his
   * picture actually travelled between one frame and half a frame later, which is
   * why it applies to the built in ten, to every move he records himself, and to a
   * keyframe he nudged by hand. → engine/render/motionBlur.ts
   */
  shutterAngle?: number
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
  /**
   * Lane height in px. ⚠️ NOT resizable, whatever this comment used to claim:
   * it is set at creation (64 for video, 60 for audio) and by one legacy
   * migration below, and nothing a user can touch ever changes it.
   */
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
  /**
   * Does this track follow a ripple that happened on ANOTHER one?
   *
   * His ask, 2026-08-13. Until then a ripple delete or ripple trim shifted only
   * the track it happened on, so everything else stayed where it was and a
   * finished edit slid quietly out of sync. That is silent damage to work he has
   * already done, which is worse than a missing feature.
   *
   * ⛔ OPTIONAL, AND `undefined` IS NOT "OFF". It means he has never touched this
   * track's switch, so the answer is DERIVED by `syncLockOf`. That gives every
   * project he already has sync on everywhere except its music beds, with no
   * migration and without writing a field into a file that never carried one.
   *
   * The moment he clicks the switch this becomes an explicit boolean and the
   * derivation stops applying, so marking a track as music LATER can never
   * silently undo a choice he made.
   */
  syncLock?: boolean
  /** Sorted by startS; clips never overlap on one track. */
  clips: Clip[]
}

/**
 * Does this track move with a ripple on another one?
 *
 * ⛔ NEVER READ `t.syncLock` DIRECTLY. One direct read is all it takes for his
 * music to start following his cuts.
 *
 * ⛔ BOTH DEFAULTS ARE HIS, ASKED BEFORE BUILDING AND ANSWERED, 2026-08-13. ON by
 * default, over "off until switched on" and over "always, with no switch"; and a
 * track he has marked as music starts OFF, so his backing track keeps its own
 * timing while the gameplay and the voice stay locked together. He can still
 * switch it on.
 *
 * Written out because this comment used to credit them to what Premiere, Resolve
 * and Final Cut do "rather than from asking him", which is backwards and would
 * have left the next session free to overturn a choice he actually made. What
 * DID come from the reference editors is the semantics of the follow itself, and
 * that is marked as such where it lives, on `syncFollow`.
 */
export const syncLockOf = (t: Track): boolean => t.syncLock ?? t.audioRole !== 'music'

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'softLight'

/**
 * A clip-level shape mask in source-UV space (0..1 across the clip's frame,
 * before transform, so it rides the clip's position/scale/rotation for free).
 * `feather` softens the edge outward, in UV units. `invert` keeps the outside.
 */
export interface ClipMask {
  kind: 'rect' | 'ellipse'
  cx: number
  cy: number
  rx: number
  ry: number
  feather: number
  invert: boolean
}

export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add', 'softLight']

/** Human labels for the blend modes, shared by the Inspector + bulk panel. */
export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  add: 'Add',
  softLight: 'Soft Light',
}

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
  /** Optional shape mask limiting where the clip shows (source-UV space). */
  mask?: ClipMask
  /** True = adjustment layer: the effect stack grades everything below it. */
  adjustment?: boolean
  /**
   * Freeze frame: the SOURCE second this clip holds for its whole length.
   * Undefined means it runs normally.
   *
   * ⛔ A TIME, NOT A FLAG, and that is the whole design. `splitClip` moves the
   * right half's `inS` forward at the cut (timeline.ts, `cutSource`), because
   * `inS`/`outS` are what give a clip its length. A flag meaning "hold `inS`"
   * would therefore make the two halves of a cut freeze show DIFFERENT frames.
   * Holding the time instead needs no change to the splitter at all: both halves
   * inherit it, and cutting a freeze cannot change what it shows.
   *
   * ⛔ AND NOT `speed: 0`, which silently does nothing: the resolver reads
   * `Math.abs(clip.speed || 1)` and zero is falsy, so it plays at normal rate.
   *
   * Cheap to play: a constant source time is one decoded frame that the frame
   * cache hands back for every frame of the hold.
   */
  freezeAtS?: number
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
   * keyframes on transform + opacity channels (see engine/anim/appearance.ts).
   * It is kept alongside the compiled keyframes so a single side can be changed and
   * the pair rebuilt deterministically, and so it can be saved as the text default.
   */
  appearance?: AppearanceSpec
  /**
   * Linked-clip group id (Vegas-style A/V link). Clips sharing a linkId move,
   * trim, split, and delete together. A video clip WITH a linkId is video-only
   * (its audio plays from the linked audio-track clip); a video clip WITHOUT a
   * linkId plays its own audio.
   */
  linkId?: Id
  /**
   * Noise-reduction strength 0..1 (RNNoise dry/wet). Absent = off. NON-
   * destructive: the recording stays raw; this only changes which samples the
   * mixers read (engine/audio.ts clipAudioBuffer), so it can be A/B'd and
   * undone freely. 1 = the full RNNoise output (OBS's suppressor config);
   * fractions crossfade toward the raw take. Deliberately NOT keyframeable.
   */
  denoise?: number
}

// Clip duration math lives HERE, next to the fields it reads, rather than in
// engine/timeline, so modules below timeline (engine/anim/appearance) can share
// the one definition without importing timeline back and forming a cycle.
// engine/timeline re-exports both, so `from './timeline'` keeps working.

const clipAbsSpeed = (clip: Clip): number => Math.abs(clip.speed || 1)

/** How long a clip occupies the timeline, in seconds. */
export const clipDurationS = (clip: Clip): number => (clip.outS - clip.inS) / clipAbsSpeed(clip)

/** Timeline time at which a clip ends, in seconds. */
export const clipEndS = (clip: Clip): number => clip.startS + clipDurationS(clip)

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
  /** Per-clip audio volume in dB, the ONLY audio channel; all three mixers
   *  inherit it through the shared clipGainEnvelope. */
  'volume',
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

/**
 * A cubic bezier in CSS `cubic-bezier(x1, y1, x2, y2)` order. The curve runs
 * from (0,0) to (1,1); x1/x2 are the timing handles, y1/y2 the value handles.
 * y is allowed outside 0..1, which is what makes overshoot expressible.
 */
export type Curve = readonly [number, number, number, number]

export interface Keyframe {
  t: number
  value: number
  ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut'
  /**
   * Optional hand-shaped bezier for the segment LEAVING this keyframe, which is
   * exactly what `ease` already describes, so x1,y1 is this keyframe's outgoing
   * handle and x2,y2 the next one's incoming handle. Present wins over `ease`;
   * absent means the named ease runs byte-identically to how it always has.
   */
  curve?: Curve
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
// Titles (Phase 5). A title clip has `title` set and an empty assetId. It is
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
   * Force letter case at render time (non-destructive, the typed text is kept).
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
    fontFamily: "'Figtree Variable', 'Segoe UI', system-ui, sans-serif",
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

/**
 * Scale every SEQUENCE-pixel measurement on a title by `k`, leaving its style
 * alone. Type size, outline, shadow, box and offsets are all absolute px against
 * the sequence raster, so anything that changes the raster a title is drawn into
 * (a format switch, a preview drawn smaller than the sequence, an export drawn
 * larger) has to bring them along or the look breaks.
 *
 * One function so those three callers cannot drift apart.
 */
export function scaleTitleDef(def: TitleDef, k: number): TitleDef {
  if (Math.abs(k - 1) < 1e-6) return def
  const s = (v: number): number => Math.round(v * k)
  return {
    ...def,
    fontSizePx: Math.max(1, s(def.fontSizePx)),
    offsetXPx: s(def.offsetXPx),
    offsetYPx: s(def.offsetYPx),
    ...(def.outline ? { outline: { ...def.outline, widthPx: s(def.outline.widthPx) } } : {}),
    ...(def.shadow
      ? { shadow: { ...def.shadow, blurPx: s(def.shadow.blurPx), dx: s(def.shadow.dx), dy: s(def.shadow.dy) } }
      : {}),
    ...(def.box ? { box: { ...def.box, paddingPx: s(def.box.paddingPx), radiusPx: s(def.box.radiusPx) } } : {}),
  }
}

/**
 * Resize a title's TYPE and bring its decoration with it.
 *
 * Outline width, shadow offset and blur, and box padding are absolute pixels,
 * while the size ladder runs 48 → 240 px. Changing size alone therefore broke
 * the look in both directions: an outline tuned at Medium is a hairline at Huge
 * and a blob at Small, and it is the main reason text here could read cheap.
 * Position is deliberately NOT scaled: resizing type must not move the title.
 */
export function withTitleFontSize(def: TitleDef, nextSizePx: number): TitleDef {
  const next = Math.max(1, Math.round(nextSizePx))
  const prev = Math.max(1, def.fontSizePx)
  if (next === prev) return def
  const k = next / prev
  // Zero is a FIXED POINT of a multiply, so any measurement that rounds to 0 on
  // the way down can never come back on the way up. The shadow or the box
  // padding would be gone for good after a there-and-back size change. Keep a
  // non-zero measurement at 1px minimum, and leave a deliberate 0 (which is how
  // "no outline" is expressed) exactly where it is.
  const s = (v: number): number => (v === 0 ? 0 : Math.max(1, Math.round(Math.abs(v) * k)) * Math.sign(v))
  return {
    ...def,
    fontSizePx: next,
    ...(def.outline ? { outline: { ...def.outline, widthPx: s(def.outline.widthPx) } } : {}),
    ...(def.shadow
      ? { shadow: { ...def.shadow, blurPx: s(def.shadow.blurPx), dx: s(def.shadow.dx), dy: s(def.shadow.dy) } }
      : {}),
    ...(def.box ? { box: { ...def.box, paddingPx: s(def.box.paddingPx), radiusPx: s(def.box.radiusPx) } } : {}),
  }
}

/**
 * An adjustment layer: no source of its own. Its effect stack (and optional
 * mask) applies to the COMPOSITE of everything below it for its time span,
 * like Premiere/Resolve adjustment layers. Discriminated like titles.
 */
export function newAdjustmentClip(startS: number, durationS = 5): Clip {
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
    adjustment: true,
  }
}


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
/**
 * GIVE A VIDEO CLIP ITS SOUND BACK WHEN ITS AUDIO PARTNER IS GONE.
 *
 * A video clip carrying a `linkId` means "my sound lives on my audio partner",
 * so the mixer and the export both skip it (`clipEmitsAudio`). **Delete that
 * partner and the video half keeps pointing at it, and the clip goes silent
 * everywhere with nothing on screen saying so.** Found 2026-08-12 in his own
 * 44-clip edit: 14 video clips pointing at partners that no longer existed, and
 * their sound was missing from every render.
 *
 * ⛔ A LINK GROUP OF ONE IS NOT ENOUGH TO CALL IT DAMAGE, and assuming that would
 * double his audio. `splitClipOnly` deliberately gives each half its own fresh
 * `linkId` precisely so the halves stay video-only while an untouched audio
 * partner keeps playing their sound. Those clips are alone in their group ON
 * PURPOSE and must not be touched.
 *
 * **What separates them is the ASSET.** A deliberate video-only clip still has an
 * audio clip from the SAME asset somewhere on the timeline. A clip whose partner
 * was deleted has none. So the link is only cleared when the group has one member
 * AND no audio clip anywhere references that asset, which is the conservative
 * side: an unrepaired clip is silent, a wrongly repaired one plays twice.
 *
 * Returns the SAME array when nothing needed repair.
 */
export function repairLostAudioLinks(tracks: Track[]): Track[] {
  const members = new Map<Id, number>()
  const assetsWithAudio = new Set<Id>()
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.linkId !== undefined) members.set(c.linkId, (members.get(c.linkId) ?? 0) + 1)
      if (t.kind === 'audio') assetsWithAudio.add(c.assetId)
    }
  }
  let changed = false
  const next = tracks.map((t) => {
    if (t.kind !== 'video') return t
    let trackChanged = false
    const clips = t.clips.map((c) => {
      if (c.linkId === undefined) return c
      if (members.get(c.linkId) !== 1) return c
      if (assetsWithAudio.has(c.assetId)) return c
      trackChanged = true
      // The key is REMOVED rather than set to undefined: `clipEmitsAudio` tests
      // `linkId === undefined`, which both satisfy, but a project file round
      // trips through JSON and an explicit undefined would not survive it.
      const rest = { ...c }
      delete rest.linkId
      return rest
    })
    if (!trackChanged) return t
    changed = true
    return { ...t, clips }
  })
  return changed ? next : tracks
}

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
    const relinked = repairLostAudioLinks(tracks)
    if (relinked !== tracks) seqChanged = true
    if (seqChanged) {
      changed = true
      sequences[id] = { ...seq, tracks: relinked }
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
