// The music's beats for Strobe on the Beat, on the MAIN thread.
//
// The pure resolver (render/resolve.ts) turns a list of beats into one flash number
// per frame, but the beats have to come from somewhere that can decode audio, and
// the export worker cannot: it has no audio and no beat cache. So the beats are
// worked out here, written onto a COPY of the sequence as `beatGridS`, and that
// copy is what the preview resolves and what the export worker is sent. Both then
// see the same beats, so a flash lands on the same frame in both.
//
// The grid never goes near the store or a saved project: it lives on a copy.
//
// Detection is the app's own (beats.ts, `detectAllOnsets`), the detector Auto-punch
// and the rail's beat snapping use. It is cached per slice of the music file like
// theirs, but with its own, finer settings: they keep a handful of the strongest
// hits across a clip (64 at most), which is right for a magnet or a punch and far
// too sparse for a strobe that should ride every beat.

import { getAudioRange } from './audio'
import { monoSlice } from './beatCache'
import { detectAllOnsets } from './beats'
import { beatGridFrom, type MusicBeats } from './effects/gym'
import type { Clip, Id, MediaAsset, Sequence, Track } from './types'

/** Two hits closer than this are one beat (about 200 BPM): hi-hats are not beats. */
const STROBE_MIN_GAP_S = 0.3

const cache = new Map<string, number[]>()
const inFlight = new Map<string, Promise<void>>()
/** Bumped whenever a slice finishes, so a memoised grid knows it is out of date. */
let version = 0

const key = (assetId: Id, inS: number, outS: number): string => `${assetId}|${inS.toFixed(4)}|${outS.toFixed(4)}`

/** Does any enabled clip in the sequence carry an enabled strobe? */
export function hasStrobe(seq: Sequence): boolean {
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      if (clip.enabled && clip.effects?.some((e) => e.enabled && e.type === 'strobe')) return true
    }
  }
  return false
}

/**
 * The clips whose beats the strobe follows: the unmuted tracks marked as music,
 * else every unmuted audio track that is not marked as voice (a project that
 * never marked its music still strobes to it).
 */
export function musicClips(seq: Sequence): Clip[] {
  const audio = seq.tracks.filter((t: Track) => t.kind === 'audio' && !t.muted)
  const marked = audio.filter((t) => t.audioRole === 'music')
  const pool = marked.length > 0 ? marked : audio.filter((t) => t.audioRole !== 'voice')
  return pool.flatMap((t) => t.clips.filter((c) => c.enabled))
}

function detect(asset: MediaAsset, inS: number, outS: number): Promise<void> {
  const k = key(asset.id, inS, outS)
  if (cache.has(k)) return Promise.resolve()
  const running = inFlight.get(k)
  if (running) return running
  const job = (async () => {
    try {
      const range = await getAudioRange(asset, inS, outS)
      if (!range) {
        cache.set(k, [])
        return
      }
      const { buffer, startS } = range
      const channels: Float32Array[] = []
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))
      const mono = monoSlice(channels, buffer.sampleRate, inS - startS, outS - startS)
      cache.set(k, detectAllOnsets(mono, buffer.sampleRate, { minGapS: STROBE_MIN_GAP_S }).map((o) => o.t))
    } catch {
      // An asset that cannot be decoded stays beatless rather than retrying forever.
      cache.set(k, [])
    } finally {
      inFlight.delete(k)
      version++
    }
  })()
  inFlight.set(k, job)
  return job
}

/** The beats of every music clip that are known right now, as one grid. */
function gridNow(clips: readonly Clip[]): number[] {
  const parts: MusicBeats[] = []
  for (const c of clips) {
    const beats = cache.get(key(c.assetId, c.inS, c.outS))
    if (beats) parts.push({ startS: c.startS, inS: c.inS, outS: c.outS, speed: c.speed, beats })
  }
  return beatGridFrom(parts)
}

const withGrid = (seq: Sequence, grid: number[]): Sequence => (grid.length > 0 ? { ...seq, beatGridS: grid } : seq)

const memo = new WeakMap<Sequence, { version: number; assets: object; out: Sequence }>()

/**
 * The sequence to PREVIEW: itself when nothing strobes, else a copy carrying the
 * beats known so far. Never waits: a slice not yet looked at is started, and
 * `onReady` fires when it lands so the monitor can repaint with the beats in. Safe
 * to call every frame; the copy is reused until the sequence or the beats change.
 */
export function previewSequence(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  onReady: () => void,
): Sequence {
  if (!hasStrobe(seq)) return seq
  const hit = memo.get(seq)
  if (hit && hit.version === version && hit.assets === assets) return hit.out
  const clips = musicClips(seq)
  for (const c of clips) {
    const asset = assets[c.assetId]
    if (asset?.hasAudio && !cache.has(key(c.assetId, c.inS, c.outS))) void detect(asset, c.inS, c.outS).then(onReady)
  }
  const out = withGrid(seq, gridNow(clips))
  memo.set(seq, { version, assets, out })
  return out
}

/**
 * The sequence to EXPORT: waits for every music slice, so the file has the beats
 * even when nobody played the music first.
 */
export async function sequenceWithBeats(seq: Sequence, assets: Record<Id, MediaAsset>): Promise<Sequence> {
  if (!hasStrobe(seq)) return seq
  const clips = musicClips(seq)
  await Promise.all(
    clips.map((c) => {
      const asset = assets[c.assetId]
      return asset?.hasAudio ? detect(asset, c.inS, c.outS) : Promise.resolve()
    }),
  )
  return withGrid(seq, gridNow(clips))
}

/**
 * Forget an asset's beats (every slice), so music put back after a missing-file
 * read is detected again instead of staying beatless until a restart.
 */
export function forgetStrobeBeats(assetId: Id): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${assetId}|`)) cache.delete(k)
  version++
}

/** For tests. */
export function clearBeatGridCache(): void {
  cache.clear()
  inFlight.clear()
  version++
}
