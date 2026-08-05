// Audio helpers that need the decoded buffer.
//
// Levelling here matches LOUDNESS, not peaks. His report, 2026-08-05: "some
// clips I'm screaming and some clips I'm speaking softly, and the volume just
// isn't balanced. The part when I scream is still very, very loud." That is
// what peak matching does. A shout and a quiet sentence can share a peak,
// because one consonant spike sets it for both, and matching those spikes
// leaves the shout far louder to a listener. See engine/loudness.ts.

import { getAudioBuffer } from '../engine/audio'
import { gainForTarget, measureLoudness, TARGET_LUFS } from '../engine/loudness'
import { activeSequence } from '../engine/types'
import { setClipGainDb } from './clipEdits'
import { useStore } from './store'
import { useToasts } from './toasts'

/** Pull the raw channels out of a decoded buffer so the pure measurer can read them. */
const channelsOf = (buffer: AudioBuffer): Float32Array[] =>
  Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))

/** Set a clip's gain so its loudest sample hits the target ceiling. */
export async function normalizeClipGain(clipId: string): Promise<void> {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset?.hasAudio) {
    useToasts.getState().show('Pick an audio clip with sound', 'danger')
    return
  }
  if (track?.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return
  }
  // Normalize sets an ABSOLUTE level; with volume keyframes active the base is
  // overridden and a single keyframe write would only pin one instant. Bail
  // honestly rather than silently half-applying.
  if (clip.keyframes?.volume?.length) {
    useToasts.getState().show('Volume is keyframed, remove the keyframes to normalize', 'danger')
    return
  }
  const buffer = await getAudioBuffer(asset)
  if (!buffer) {
    useToasts.getState().show('Could not decode the audio', 'danger')
    return
  }
  const measured = measureLoudness(channelsOf(buffer), buffer.sampleRate, clip.inS, clip.outS)
  const db = gainForTarget(measured, TARGET_LUFS)
  if (db === null) {
    useToasts.getState().show('That clip is silent', 'danger')
    return
  }
  setClipGainDb(clipId, db)
  useToasts.getState().show(`Levelled (${db > 0 ? '+' : ''}${db.toFixed(1)} dB)`)
}

/**
 * Level EVERY clip that makes sound to the same loudness, in one undo step.
 *
 * This is the answer to "the volume just isn't balanced": one clip at a time was
 * never the problem, the problem is the clips disagreeing with each other. Every
 * clip is measured over its own in/out range rather than over its whole source
 * file, so pieces cut from ONE long recording still get levelled against each
 * other. That matters: the loud and quiet parts he means are often the same
 * take.
 *
 * Clips with volume keyframes are left alone and counted, never half-applied: a
 * single gain write cannot express a curve, and silently flattening one would
 * throw away work.
 */
export async function balanceAllClipLoudness(): Promise<void> {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const show = useToasts.getState().show
  const targets = seq.tracks
    .filter((t) => !t.locked)
    .flatMap((t) => t.clips.map((c) => ({ clip: c, asset: s.project.assets[c.assetId] })))
    .filter((x) => x.asset?.hasAudio)
  if (targets.length === 0) {
    show('Nothing on the timeline makes any sound', 'danger')
    return
  }

  const gains: { id: string; db: number }[] = []
  let keyframed = 0
  let silent = 0
  for (const { clip, asset } of targets) {
    if (clip.keyframes?.volume?.length) {
      keyframed++
      continue
    }
    const buffer = await getAudioBuffer(asset)
    if (!buffer) {
      silent++
      continue
    }
    const db = gainForTarget(
      measureLoudness(channelsOf(buffer), buffer.sampleRate, clip.inS, clip.outS),
      TARGET_LUFS,
    )
    if (db === null) silent++
    else gains.push({ id: clip.id, db })
  }
  if (gains.length === 0) {
    show('Could not measure any of those clips', 'danger')
    return
  }
  // ONE undo step for the whole pass. Levelling forty clips and leaving forty
  // entries in the history would make undoing it a chore instead of a keypress.
  useStore.getState().dispatch('Balance volume', (p) => {
    const sq = activeSequence(p)
    const byId = new Map(gains.map((g) => [g.id, g.db]))
    return {
      ...p,
      sequences: {
        ...p.sequences,
        [sq.id]: {
          ...sq,
          tracks: sq.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (byId.has(c.id) ? { ...c, audioGainDb: byId.get(c.id)! } : c)),
          })),
        },
      },
    }
  })
  const skipped = [keyframed > 0 && `${keyframed} with volume curves`, silent > 0 && `${silent} silent`]
    .filter(Boolean)
    .join(', ')
  show(`Balanced ${gains.length} clip${gains.length === 1 ? '' : 's'}${skipped ? ` (left ${skipped})` : ''}`)
}
