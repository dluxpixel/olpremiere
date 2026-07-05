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
  /** Sorted by startS; clips never overlap on one track. */
  clips: Clip[]
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay'

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

export type Keyframeable = number | { keyframes: Keyframe[] }

export interface Keyframe {
  t: number
  value: number
  ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut'
}

export interface Transition {
  type: string
  durationS: number
}

export interface Marker {
  id: Id
  t: number
  label: string
  color: string
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
    height: kind === 'video' ? 64 : 48,
    muted: false,
    solo: false,
    locked: false,
    clips: [],
  }
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
