// Zod validation gate for a persisted Project document (P4 persistence hardening).
//
// state/persistence.ts loads a stored document from IndexedDB and, today, casts
// it straight to Project and runs migrateProject on it. A corrupt or wrong shaped
// document (a torn write, a hand edited blob, a doc from a future build gone
// wrong) would flow straight into migrate and the render engine, where iterating
// a non array `tracks`, or doing timeline math on a string `startS`, either
// crashes or silently poisons the app.
//
// parseStoredProject is the safe gate: it validates the load bearing spine and
// returns a typed Project, or null on ANY validation failure. It never throws.
//
// Design:
//  - The spine is validated STRICTLY: `sequences` is a record of Sequence, every
//    Sequence carries an array of Track, every Track an array of Clip, every Clip
//    the numeric timing fields (startS / inS / outS / speed) and an `effects`
//    array, and every id is a string. These are exactly the shapes migrate and
//    the renderer iterate, so a wrong type here fails the gate.
//  - Everything else is PERMISSIVE. Every object uses .catchall(z.unknown()), so
//    unknown / newer / optional fields (clip.title, clip.keyframes, clip.filters,
//    transitions, marker colours, asset codecs, or a field a future build adds)
//    pass through UNTOUCHED and survive a load then save round trip. Without this,
//    a newer document opened by an older build would be silently stripped and then
//    autosaved, destroying data.
//  - Fields that migrateProject backfills (Track.volumeDb, Track.pan) are optional
//    here, so a pre mixer document still passes the gate; migrate fills them in
//    the very next step of the load pipeline.
//
// Note: z.number() in zod v4 already rejects NaN and Infinity, so the numeric
// timing fields reject those poison values for free.

import { z } from 'zod'

import type { Project } from '../engine/types'

const num = z.number()
const str = z.string()
const bool = z.boolean()

const TransformSchema = z
  .object({
    x: num,
    y: num,
    scale: num,
    rotationDeg: num,
    anchorX: num,
    anchorY: num,
    crop: z.object({ t: num, r: num, b: num, l: num }).catchall(z.unknown()),
  })
  .catchall(z.unknown())

const EffectInstanceSchema = z
  .object({
    id: str,
    type: str,
    enabled: bool,
    // Keyframeable params (number, or { value, keyframes }) are not deeply
    // validated: a forward compatible effect may carry new param shapes, and a
    // params bag never drives timeline iteration. It just has to be an object.
    params: z.record(str, z.unknown()),
  })
  .catchall(z.unknown())

const ClipSchema = z
  .object({
    id: str,
    assetId: str,
    // Load bearing timing fields. z.number() also rejects NaN and Infinity.
    startS: num,
    inS: num,
    outS: num,
    speed: num,
    enabled: bool,
    transform: TransformSchema,
    opacity: num,
    // blendMode is a string union in the type, kept as a plain string so a future
    // blend mode never fails the gate.
    blendMode: str,
    audioGainDb: num,
    fadeInS: num,
    fadeOutS: num,
    effects: z.array(EffectInstanceSchema),
    // Optional decorations (transitionIn / transitionOut, label, linkId,
    // keyframes, filters, title) are intentionally NOT modelled here: the
    // .catchall below preserves them verbatim without risking a false rejection
    // over a non spine field.
  })
  .catchall(z.unknown())

const MarkerSchema = z.object({ id: str, t: num }).catchall(z.unknown())

const TrackSchema = z
  .object({
    id: str,
    kind: z.enum(['video', 'audio']),
    name: str,
    height: num,
    muted: bool,
    solo: bool,
    locked: bool,
    // Backfilled by migrateProject for pre mixer documents, so optional here.
    volumeDb: num.optional(),
    pan: num.optional(),
    // Auto-duck opt-in (engine/ducking.ts); absent on older documents.
    audioRole: z.enum(['voice', 'music']).optional(),
    clips: z.array(ClipSchema),
  })
  .catchall(z.unknown())

const SequenceSchema = z
  .object({
    id: str,
    name: str,
    fps: num,
    width: num,
    height: num,
    sampleRate: num,
    durationS: num,
    tracks: z.array(TrackSchema),
    markers: z.array(MarkerSchema),
    inPointS: num.optional(),
    outPointS: num.optional(),
  })
  .catchall(z.unknown())

const MediaAssetSchema = z
  .object({
    id: str,
    name: str,
    kind: z.enum(['video', 'audio', 'image']),
    blobKey: str,
    durationS: num,
    hasAudio: bool,
    hasVideo: bool,
    // width / height / fps / thumbnailKey / codec are optional metadata; left to
    // .catchall so an odd value never nukes an otherwise loadable project.
  })
  .catchall(z.unknown())

const SettingsSchema = z
  .object({ fps: num, width: num, height: num, sampleRate: num })
  .catchall(z.unknown())

/**
 * Zod schema for a persisted Project. Exported for reuse and testing. Prefer
 * parseStoredProject at real call sites: it returns a typed Project or null and
 * never throws.
 */
export const ProjectSchema = z
  .object({
    id: str,
    name: str,
    createdAt: num,
    updatedAt: num,
    assets: z.record(str, MediaAssetSchema),
    sequences: z.record(str, SequenceSchema),
    activeSequenceId: str,
    settings: SettingsSchema,
  })
  .catchall(z.unknown())

/**
 * Validate a value loaded from storage. Returns the typed Project on success, or
 * null on ANY validation failure. Never throws.
 *
 * The caller should run migrateProject / migrateProjectEffects on the result to
 * backfill fields the schema permits to be absent (Track.volumeDb, Track.pan).
 * On null the caller must NOT overwrite the stored document, so a corrupt doc can
 * still be recovered rather than clobbered by an autosave of a fresh project.
 */
export function parseStoredProject(raw: unknown): Project | null {
  const result = ProjectSchema.safeParse(raw)
  if (!result.success) return null
  // Boundary assertion: the schema validates the load bearing spine and preserves
  // every other key via .catchall, but its inferred type carries `unknown` in the
  // permissive slots, so it is not structurally identical to Project. The load
  // pipeline runs migrateProject next, which fills the optional mixer fields.
  return result.data as unknown as Project
}
