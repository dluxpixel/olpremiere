/**
 * Time stretching that keeps the pitch where it was.
 *
 * Playing a buffer faster by resampling it (which is all
 * `AudioBufferSourceNode.playbackRate` does) shortens the audio AND raises
 * every frequency in it, so a voice at 2x turns into a chipmunk. Every real
 * editor separates the two: the clip gets shorter, the voice stays his.
 *
 * The algorithm is WSOLA (waveform similarity overlap-add), the same family
 * SoundTouch uses. Output is built in fixed blocks; for each block the reader
 * hunts, inside a small window, for the input position whose waveform lines up
 * best with the tail already written, then cross-fades onto it. Lining the
 * periods up is what stops the joins from clicking, and because no sample is
 * ever resampled the pitch cannot move.
 *
 * ⛔ THE LENGTH IS THE CALLER'S, NOT OURS. `outFrames` is an input, not a
 * result. Rounding a stretch factor independently here would let the audio
 * drift a sample or two away from the picture it was cut against, which is the
 * one failure a stretch must never have. Every path that used to divide by
 * |speed| still does its own division, and this function hits that number
 * exactly.
 */

/** Analysis frame. 40 ms is long enough to hold a pitch period of a low voice. */
const SEQUENCE_MS = 40
/** How far the reader may hunt for a better-matching join, either way. */
const SEEK_WINDOW_MS = 15
/** Cross-fade length at each join. */
const OVERLAP_MS = 8

/**
 * The similarity hunt runs coarsely first and then refines around the winner.
 * A full-resolution hunt is hundreds of millions of multiplies over a long clip
 * and would stall the scheduling call it runs inside, and the hunt is most of
 * this module's cost: measured 2026-08-14 on a minute of stereo speech at 2x,
 * 110 ms searching every 4th sample and 71 ms at this setting.
 *
 * 8 samples is 0.17 ms at 48 kHz, so even a high voice's pitch period is
 * sampled dozens of times and the coarse pass cannot miss the right hill. The
 * exact peak is then found at full resolution within +/- 8.
 */
const SEEK_DECIMATION = 8

/**
 * Stretch (or squeeze) `channels` to exactly `outFrames` samples without
 * moving the pitch. Every channel is stretched with the SAME join offsets, so
 * a stereo image cannot smear apart; the offsets are chosen from a mono
 * downmix of the input.
 *
 * Returns fresh arrays. An input already at the requested length is passed
 * straight back (same references, no copy), which is the speed-1 case and by
 * far the common one.
 */
export function timeStretchChannels(
  channels: readonly Float32Array[],
  outFrames: number,
  sampleRate: number,
): Float32Array[] {
  const target = Math.max(0, Math.round(outFrames))
  if (channels.length === 0) return []
  const inLen = channels[0].length
  if (target === inLen) return channels.slice()
  if (target === 0 || inLen === 0) return channels.map(() => new Float32Array(target))

  const overlap = Math.max(4, Math.round((OVERLAP_MS / 1000) * sampleRate))
  const seq = Math.max(2 * overlap + 8, Math.round((SEQUENCE_MS / 1000) * sampleRate))
  const seek = Math.max(1, Math.round((SEEK_WINDOW_MS / 1000) * sampleRate))
  const hopOut = seq - overlap

  // Too short to hold even one analysis frame plus its hunt: there is no
  // waveform similarity to find, so fall back to plain resampling. It moves
  // the pitch, but only across a fragment shorter than a blink.
  if (inLen < seq + seek) {
    return channels.map((ch) => resampleToLength(ch, target))
  }

  const mono = downmix(channels)
  const out = channels.map(() => new Float32Array(target))
  // Carried tail of the block just written: what the next join fades out of.
  const mid = channels.map((ch) => ch.slice(0, overlap))
  const midMono = mono.slice(0, overlap)

  const hopIn = (hopOut * inLen) / target
  let inPos = 0
  let outPos = 0
  let first = true

  while (outPos < target) {
    const nominal = Math.round(inPos)
    // The first block is the input's own head, so it joins to itself and the
    // cross-fade below is an identity. Every later block earns its position.
    const readAt = first ? 0 : nominal + bestJoinOffset(mono, midMono, nominal, seek, overlap)
    first = false

    // How much of this frame is safely inside the input. Bounds-checking once
    // per frame instead of once per sample is worth a lot here: these loops run
    // over every output sample of every channel.
    const emit = Math.min(hopOut, target - outPos)
    const safeFrom = Math.max(0, -readAt)
    const safeTo = Math.min(emit, inLen - readAt)

    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch]
      const dst = out[ch]
      const tail = mid[ch]
      const xfade = Math.min(overlap, emit)
      // Cross-fade the carried tail into the newly chosen position.
      for (let i = 0; i < xfade; i++) {
        const w = i / overlap
        const s = i >= safeFrom && i < safeTo ? src[readAt + i] : 0
        dst[outPos + i] = tail[i] * (1 - w) + s * w
      }
      // Then the untouched middle of the frame, straight through.
      const flatFrom = Math.max(xfade, safeFrom)
      for (let i = xfade; i < flatFrom && i < emit; i++) dst[outPos + i] = 0
      const flatTo = Math.min(emit, safeTo)
      for (let i = flatFrom; i < flatTo; i++) dst[outPos + i] = src[readAt + i]
      for (let i = Math.max(flatFrom, flatTo); i < emit; i++) dst[outPos + i] = 0
      // And carry the frame's own tail for the next join.
      const tailAt = readAt + hopOut
      for (let i = 0; i < overlap; i++) {
        const k = tailAt + i
        tail[i] = k >= 0 && k < inLen ? src[k] : 0
      }
    }
    const monoTailAt = readAt + hopOut
    for (let i = 0; i < overlap; i++) {
      const k = monoTailAt + i
      midMono[i] = k >= 0 && k < mono.length ? mono[k] : 0
    }

    outPos += hopOut
    inPos += hopIn
  }

  return out
}

/**
 * The offset, within +/- half the seek window, whose waveform best matches the
 * tail we are joining from. Scored by cross-correlation normalised against the
 * candidate's own energy, so a loud passage cannot win on volume alone.
 */
function bestJoinOffset(
  mono: Float32Array,
  midMono: Float32Array,
  nominal: number,
  seek: number,
  overlap: number,
): number {
  const half = Math.floor(seek / 2)
  let best = 0
  let bestScore = -Infinity
  for (let o = -half; o <= half; o += SEEK_DECIMATION) {
    const s = similarity(mono, midMono, nominal + o, overlap, SEEK_DECIMATION)
    if (s > bestScore) {
      bestScore = s
      best = o
    }
  }
  const lo = Math.max(-half, best - SEEK_DECIMATION)
  const hi = Math.min(half, best + SEEK_DECIMATION)
  bestScore = -Infinity
  let refined = best
  for (let o = lo; o <= hi; o++) {
    const s = similarity(mono, midMono, nominal + o, overlap, 1)
    if (s > bestScore) {
      bestScore = s
      refined = o
    }
  }
  return refined
}

function similarity(
  mono: Float32Array,
  midMono: Float32Array,
  at0: number,
  overlap: number,
  stride: number,
): number {
  let dot = 0
  let energy = 0
  // The window sits wholly inside the input for all but the first and last few
  // frames; taking the bounds check out of that loop is most of this function's
  // cost, and it runs a few hundred times per output frame.
  if (at0 >= 0 && at0 + overlap <= mono.length) {
    for (let i = 0; i < overlap; i += stride) {
      const x = mono[at0 + i]
      dot += x * midMono[i]
      energy += x * x
    }
  } else {
    for (let i = 0; i < overlap; i += stride) {
      const x = at(mono, at0 + i)
      dot += x * midMono[i]
      energy += x * x
    }
  }
  // Silence correlates with everything; score it 0 so the nominal position wins.
  if (energy < 1e-12) return 0
  return dot / Math.sqrt(energy)
}

/** Read with zeros outside the buffer, so joins near either edge stay in range. */
function at(buf: Float32Array, i: number): number {
  return i >= 0 && i < buf.length ? buf[i] : 0
}

/** Mono fold used only to choose join offsets, never to produce output. */
function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const n = channels[0].length
  const out = new Float32Array(n)
  for (const ch of channels) {
    const m = Math.min(n, ch.length)
    for (let i = 0; i < m; i++) out[i] += ch[i]
  }
  for (let i = 0; i < n; i++) out[i] /= channels.length
  return out
}

/**
 * Linear resample to an exact length. Only the degenerate path above uses it:
 * this is the pitch-moving behaviour the whole file exists to replace.
 */
function resampleToLength(src: Float32Array, outFrames: number): Float32Array {
  const out = new Float32Array(outFrames)
  if (outFrames === 0 || src.length === 0) return out
  const step = src.length / outFrames
  for (let j = 0; j < outFrames; j++) {
    const pos = j * step
    const i0 = Math.floor(pos)
    const frac = pos - i0
    out[j] = at(src, i0) * (1 - frac) + at(src, i0 + 1) * frac
  }
  return out
}
