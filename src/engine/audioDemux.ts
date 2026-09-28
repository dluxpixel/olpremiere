// The audio read, with no AudioContext in sight, so it runs the same in a Worker
// (audioDecodeWorker.ts) and on the main thread (the fallback in audio.ts).
//
// ⛔ WHY IT LEFT audio.ts, 2026-09-28. His words: *"The app is laggy when I have
// multiple projects or way too many items in a single project."* Measured on a
// copy of his biggest project (17 audible assets, 3042 s of source sound): with
// the read on the main thread, playback ran at about 23 fps with 111 of 191
// frames late, and roughly a third of the main thread during play was this
// demux, re-reading sound the cache had just thrown away. Moving the read into a
// worker takes it off the thread that draws the picture and answers his mouse.

import type { AudioSample, InputAudioTrack } from 'mediabunny'

/**
 * The demuxer's read window. mediabunny's own default is 8 MB; halved because
 * two reads run at once.
 */
export const DEMUX_CACHE_BYTES = 4 * 1024 * 1024

export interface DemuxRequest {
  /** The asset's duration as the project knows it, the time axis every buffer uses. */
  durationS: number
  /** Source seconds to start at. Omitted means the start of the file. */
  fromS?: number
  /** Source seconds to stop at. Omitted means the end of the file. */
  toS?: number
}

export type DemuxResult =
  /** The file holds no audio track at all. Proof of silence, not a guess. */
  | { kind: 'silent' }
  /** A track exists but this build cannot decode it: the caller may fall back. */
  | { kind: 'undecodable' }
  | { kind: 'pcm'; sampleRate: number; startS: number; planes: Float32Array[] }

async function openTrack(blob: Blob): Promise<{ track: InputAudioTrack | null; dispose: () => void }> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { maxCacheSize: DEMUX_CACHE_BYTES }) })
  try {
    return { track: await input.getPrimaryAudioTrack(), dispose: () => input.dispose() }
  } catch (err) {
    input.dispose()
    throw err
  }
}

/**
 * Decode source seconds [fromS, toS) of the file's primary audio track into
 * float32 planes. Sample 0 of every plane is `startS` of source time.
 *
 * ⛔ SIZED FROM `durationS`, NOT FROM THE CONTAINER, and the AAC head is
 * subtracted: the same two rules the whole file read has always followed (an AAC
 * track's first packet does not start at zero, 21 to 44 ms of lip sync on every
 * video). A range is the same axis cut shorter, so a range and a whole read of
 * the same file agree sample for sample.
 */
export async function demuxAudio(blob: Blob, req: DemuxRequest): Promise<DemuxResult> {
  const { track, dispose } = await openTrack(blob)
  try {
    if (!track) return { kind: 'silent' }
    if (!(await track.canDecode())) return { kind: 'undecodable' }
    const sampleRate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    if (!(sampleRate > 0) || !(channels > 0)) return { kind: 'undecodable' }
    const durationS = req.durationS > 0 ? req.durationS : await track.computeDuration()
    const fromS = Math.max(0, Math.min(req.fromS ?? 0, durationS))
    const toS = Math.max(fromS, Math.min(req.toS ?? durationS, durationS))
    const length = Math.max(1, Math.round((toS - fromS) * sampleRate))
    const firstTs = await track.getFirstTimestamp()
    const planes: Float32Array[] = []
    for (let ch = 0; ch < channels; ch++) planes.push(new Float32Array(length))
    const { AudioSampleSink } = await import('mediabunny')
    const ranged = req.fromS !== undefined || req.toS !== undefined
    const samples = ranged
      ? new AudioSampleSink(track).samples(firstTs + fromS, firstTs + toS)
      : new AudioSampleSink(track).samples()
    for await (const sample of samples) {
      try {
        if (!placeSample(sample, planes, length, sampleRate, firstTs + fromS)) break
      } finally {
        sample.close()
      }
    }
    return { kind: 'pcm', sampleRate, startS: fromS, planes }
  } finally {
    // An undisposed Input retains its read orchestrator, its workers and an open
    // stream reader on the blob.
    dispose()
  }
}

/**
 * Copy one decoded sample into the planes at its place on the time axis.
 * Returns false once the sample starts past the end, so the read can stop.
 *
 * ⚠️ CLAMPED, BECAUSE `copyTo` THROWS RATHER THAN TRUNCATING.
 */
function placeSample(sample: AudioSample, planes: Float32Array[], length: number, sampleRate: number, originTs: number): boolean {
  const at = Math.round((sample.timestamp - originTs) * sampleRate)
  if (at >= length) return false
  const start = Math.max(0, at)
  const skip = start - at
  const frameCount = Math.min(sample.numberOfFrames - skip, length - start)
  if (frameCount <= 0) return true
  for (let ch = 0; ch < Math.min(planes.length, sample.numberOfChannels); ch++) {
    sample.copyTo(planes[ch]!.subarray(start, start + frameCount), {
      planeIndex: ch,
      format: 'f32-planar',
      frameOffset: skip,
      frameCount,
    })
  }
  return true
}

export type PeaksResult = { kind: 'silent' } | { kind: 'undecodable' } | { kind: 'peaks'; peaks: Float32Array }

/**
 * Abs-peak per bucket across every channel of the whole file, WITHOUT holding
 * the file's sound in memory: each decoded sample is reduced into the buckets
 * and dropped. His 1839 s music track used to become 674 MB of float32 just so
 * the timeline could draw a few hundred columns of it.
 */
export async function demuxPeaks(blob: Blob, durationS: number, buckets: number): Promise<PeaksResult> {
  const { track, dispose } = await openTrack(blob)
  try {
    if (!track) return { kind: 'silent' }
    if (!(await track.canDecode())) return { kind: 'undecodable' }
    const sampleRate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    if (!(sampleRate > 0) || !(channels > 0)) return { kind: 'undecodable' }
    const dur = durationS > 0 ? durationS : await track.computeDuration()
    const total = Math.max(1, Math.round(dur * sampleRate))
    const n = Math.max(1, Math.floor(buckets))
    const peaks = new Float32Array(n)
    const firstTs = await track.getFirstTimestamp()
    let scratch = new Float32Array(0)
    const { AudioSampleSink } = await import('mediabunny')
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const at = Math.round((sample.timestamp - firstTs) * sampleRate)
        if (at >= total) break
        const frames = sample.numberOfFrames
        if (scratch.length < frames) scratch = new Float32Array(frames)
        for (let ch = 0; ch < Math.min(channels, sample.numberOfChannels); ch++) {
          const view = scratch.subarray(0, frames)
          sample.copyTo(view, { planeIndex: ch, format: 'f32-planar' })
          for (let j = 0; j < frames; j++) {
            const pos = at + j
            if (pos < 0) continue
            if (pos >= total) break
            const b = Math.min(n - 1, Math.floor((pos * n) / total))
            const v = view[j]! < 0 ? -view[j]! : view[j]!
            if (v > peaks[b]!) peaks[b] = v > 1 ? 1 : v
          }
        }
      } finally {
        sample.close()
      }
    }
    return { kind: 'peaks', peaks }
  } finally {
    dispose()
  }
}
