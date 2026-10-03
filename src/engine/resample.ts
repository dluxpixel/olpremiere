// Sample rate conversion, done in the app itself rather than handed to Web Audio.
//
// ⛔ WHY NOT LET WEB AUDIO DO IT. An AudioBufferSourceNode converts a buffer's
// rate by LINEAR INTERPOLATION. Measured on this app's export, 2026-09-29, a
// 44.1 kHz source in the 48 kHz mix: -1.5 dB at 10 kHz, -3.4 dB at 15 kHz, and an
// alias at 18.9 kHz only 11.6 dB under the tone (a 5 kHz tone threw an 8.9 kHz
// alias at -35.8 dBc). That was every one of his mp3 songs and sound effects,
// and every YouTube download, in every export. His words, 2026-09-29: *"I want
// the quality to be absolutely the highest, audio and video."*
//
// This is a rational polyphase windowed sinc: Kaiser beta 10, 48 zero crossings
// each side at the lower of the two rates, cutoff 0.955 of the lower Nyquist,
// every phase normalised to unity gain at DC. Measured 44.1 to 48 kHz: flat to
// 19 kHz within 0.001 dB, every alias at or below -110 dBc. The kernel is
// symmetric about the output instant, so it adds NO delay: sample 0 in is sample
// 0 out, and a round trip lines up with the original sample for sample, which is
// what lets a resampled wet signal be crossfaded against its dry source without
// combing (the voice takes, denoise.ts).
//
// ONE resampler serves the whole app: the decode (audioDemux.ts, every source
// not at 48 kHz, once, in the decode worker) and the voice takes. Two would be
// two things to reason about.

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** Modified Bessel function of the first kind, order 0 (the Kaiser window). */
function bessel0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

const HALF_ZERO_CROSSINGS = 48
const KAISER_BETA = 10
const ROLLOFF = 0.955
/**
 * Past this many phases the kernel is drawn at this many and interpolated
 * between them. Every rate a file really carries (8, 11.025, 16, 22.05, 24, 32,
 * 44.1, 48, 88.2, 96, 176.4, 192 kHz) needs 640 or fewer against 48 kHz and is
 * EXACT; this only keeps an odd rate from building a table the size of the rate.
 */
const MAX_PHASES = 1024

interface Kernel {
  /** Output sample m reads the input at m * down / up. */
  up: number
  down: number
  /** Rows in the table: `up` when exact, else MAX_PHASES drawn and interpolated. */
  phases: number
  exact: boolean
  /** Taps per phase (a multiple of 8), and how many sit at or before the output instant. */
  taps: number
  half: number
  /** `phases + 1` rows of `taps`; the last row is the first one a sample later. */
  table: Float32Array
}

const kernels = new Map<string, Kernel>()

function kernelFor(fromRate: number, toRate: number): Kernel {
  const key = `${fromRate}>${toRate}`
  const hit = kernels.get(key)
  if (hit) return hit
  const g = gcd(fromRate, toRate)
  const up = toRate / g
  const down = fromRate / g
  const exact = up <= MAX_PHASES
  const phases = exact ? up : MAX_PHASES
  const cutoff = (ROLLOFF * Math.min(fromRate, toRate)) / 2 / fromRate // cycles per INPUT sample
  // Taps per side in INPUT samples: wider when going down, so the zero crossings
  // stay 48 at the lower rate. A multiple of 4, so the taps come in eights for
  // the SIMD sum below (the extra taps sit where the window is all but zero).
  const half = 4 * Math.ceil(HALF_ZERO_CROSSINGS / Math.min(1, toRate / fromRate) / 4)
  const taps = 2 * half
  const table = new Float32Array((phases + 1) * taps)
  const i0b = bessel0(KAISER_BETA)
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases
    let sum = 0
    for (let j = 0; j < taps; j++) {
      // Distance in input samples from tap j to the output instant.
      const u = j - (half - 1) - frac
      const x = 2 * cutoff * u
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const r = u / half
      const w = Math.abs(r) >= 1 ? 0 : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b
      const v = sinc * w
      table[p * taps + j] = v
      sum += v
    }
    for (let j = 0; j < taps; j++) table[p * taps + j]! /= sum
  }
  const k: Kernel = { up, down, phases, exact, taps, half, table }
  kernels.set(key, k)
  return k
}

// ---------------------------------------------------------------------------
// ⛔ THE SUM RUNS AS WEBASSEMBLY SIMD, BECAUSE IN PLAIN JS IT COST MORE THAN THE
// DECODE. Measured 2026-10-01 in Node 22 (the V8 Electron runs): the kernel in
// JS took 6 to 8 ms per second of stereo, so his 1839 s music track would have
// spent 13 s resampling on every whole read. Four lanes at a time it is 0.9 ms
// per second. His lag pass, 2026-09-28: playback must stay smooth.
//
// The module is a few hundred bytes, assembled here from readable parts rather
// than shipped as an opaque blob. It does one thing: for `n` outputs in a row it
// sums `taps` window samples against the phase's row of the table, for two
// channels at once, and steps the phase. Everything else stays in TypeScript.
// Where WebAssembly SIMD is missing the same sums run in JS, so nothing breaks.

const uleb = (n: number): number[] => {
  const out: number[] = []
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n) byte |= 0x80
    out.push(byte)
  } while (n)
  return out
}
const section = (id: number, bytes: number[]): number[] => [id, ...uleb(bytes.length), ...bytes]
const wasmName = (s: string): number[] => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))]

function simdKernelBytes(): Uint8Array {
  const I32 = 0x7f
  const V128 = 0x7b
  const get = (i: number) => [0x20, i]
  const set = (i: number) => [0x21, i]
  const tee = (i: number) => [0x22, i]
  const i32 = (v: number) => [0x41, v] // small non-negative constants only
  const [ADD, SUB, MUL, SHL, DIVU, REMU, LTU, EQZ] = [0x6a, 0x6b, 0x6c, 0x74, 0x6e, 0x70, 0x49, 0x45]
  const BLOCK = [0x02, 0x40]
  const LOOP = [0x03, 0x40]
  const END = 0x0b
  const brIf = (depth: number) => [0x0d, depth]
  const vload = (offset: number) => [0xfd, 0x00, 0x00, offset] // v128.load, align 1
  const fmul = [0xfd, 0xe6, 0x01] // f32x4.mul
  const fadd = [0xfd, 0xe4, 0x01] // f32x4.add
  const lane = (l: number) => [0xfd, 0x1f, l] // f32x4.extract_lane
  const vzero = [0xfd, 0x0c, ...new Array<number>(16).fill(0)] // v128.const 0
  const F32_ADD = 0x92
  const F32_STORE = [0x38, 0x02, 0x00]
  // Params: 0 n, 1 x (window index of the first tap), 2 r (phase), 3 win0,
  // 4 win1, 5 table, 6 out0, 7 out1 (byte addresses), 8 taps, 9 up, 10 down.
  // Locals: 11 p0, 12 p1, 13 row, 14 k, 15 row bytes, 16..19 sums, 20 coefficients.
  const mac = (sum: number, p: number, offset: number) => [
    ...get(sum), ...get(p), ...get(14), ADD, ...vload(offset), ...get(20), ...fmul, ...fadd, ...set(sum),
  ]
  // The four lanes added pairwise, (l0 + l1) + (l2 + l3).
  const hsum = (v: number) => [
    ...get(v), ...lane(0), ...get(v), ...lane(1), F32_ADD, ...get(v), ...lane(2), ...get(v), ...lane(3), F32_ADD, F32_ADD,
  ]
  const body = [
    0x02, 0x05, I32, 0x05, V128,
    ...get(8), ...i32(2), SHL, ...set(15),
    ...BLOCK,
    ...get(0), EQZ, ...brIf(0),
    ...LOOP,
    ...get(3), ...get(1), ...i32(2), SHL, ADD, ...set(11),
    ...get(4), ...get(1), ...i32(2), SHL, ADD, ...set(12),
    ...get(5), ...get(2), ...get(15), MUL, ADD, ...set(13),
    ...vzero, ...tee(16), ...tee(17), ...tee(18), ...set(19),
    ...i32(0), ...set(14),
    ...LOOP,
    ...get(13), ...get(14), ADD, ...vload(0), ...set(20),
    ...mac(16, 11, 0), ...mac(18, 12, 0),
    ...get(13), ...get(14), ADD, ...vload(16), ...set(20),
    ...mac(17, 11, 16), ...mac(19, 12, 16),
    ...get(14), ...i32(32), ADD, ...tee(14), ...get(15), LTU, ...brIf(0),
    END,
    ...get(16), ...get(17), ...fadd, ...set(16),
    ...get(18), ...get(19), ...fadd, ...set(18),
    ...get(6), ...hsum(16), ...F32_STORE,
    ...get(7), ...hsum(18), ...F32_STORE,
    ...get(6), ...i32(4), ADD, ...set(6),
    ...get(7), ...i32(4), ADD, ...set(7),
    // r += down; x += r / up; r %= up
    ...get(2), ...get(10), ADD, ...set(2),
    ...get(1), ...get(2), ...get(9), DIVU, ADD, ...set(1),
    ...get(2), ...get(9), REMU, ...set(2),
    ...get(0), ...i32(1), SUB, ...tee(0), ...brIf(0),
    END,
    END,
    END,
  ]
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 11, ...new Array<number>(11).fill(I32), 0]),
    ...section(2, [1, ...wasmName('env'), ...wasmName('mem'), 0x02, 0x00, 0x01]),
    ...section(3, [1, 0]),
    ...section(7, [1, ...wasmName('run'), 0x00, 0x00]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ])
}

type SimdRun = (
  n: number, x: number, r: number, win0: number, win1: number, table: number,
  out0: number, out1: number, taps: number, up: number, down: number,
) => void

let simdModule: WebAssembly.Module | null | undefined

function getSimdModule(): WebAssembly.Module | null {
  if (simdModule !== undefined) return simdModule
  simdModule = null
  try {
    const bytes = simdKernelBytes()
    if (typeof WebAssembly === 'object' && WebAssembly.validate(bytes)) simdModule = new WebAssembly.Module(bytes)
  } catch {
    simdModule = null
  }
  return simdModule
}

/** Outputs computed per call into WebAssembly memory before they are copied out. */
const SIMD_CHUNK = 4096

/** Copies `count` frames of channel `ch`, from `frameOffset` of the source, into `dest`. */
export type FrameCopier = (ch: number, dest: Float32Array, frameOffset: number, count: number) => void

/** Input frames held at once, beyond the kernel: about 0.7 s at 44.1 kHz. */
const WINDOW_FRAMES = 1 << 15

/**
 * The resampler fed a piece at a time, so a long file never needs its whole
 * sound at BOTH rates in memory at once: his 1839 s music track is 649 MB of
 * float32 at 44.1 kHz and 706 MB at 48 kHz, and holding both would have been
 * 1.35 GB in one worker. This holds the output and a window of input.
 *
 * Every index is on the WHOLE FILE's axes: input index i is input sample i of
 * the file, output index m is output sample m. The output covers [outStart,
 * outEnd) and reads only input in [0, inEnd); everything outside is silence.
 * That is what makes a range read and a whole read of the same file agree
 * sample for sample: output m is the same sum over the same input either way.
 *
 * Input must arrive in order (decoded audio does). A gap reads as silence, and
 * input that lands behind what has already been settled is dropped.
 */
export class StreamResampler {
  readonly output: Float32Array[]
  private readonly k: Kernel
  private readonly window: Float32Array[]
  /** Input index of window[0]. */
  private winStart: number
  /** Every input index below this is final: written, or a gap that stays silent. */
  private settled: number
  /** The next output index to compute. */
  private next: number
  private readonly simd: {
    run: SimdRun
    table: number
    win: number[]
    out: [number, number]
    outView: [Float32Array, Float32Array]
  } | null = null

  constructor(
    fromRate: number,
    toRate: number,
    channels: number,
    private readonly span: { inEnd: number; outStart: number; outEnd: number },
    /** False runs the plain JS sums, for the tests that hold the two to each other. */
    options: { simd?: boolean } = {},
  ) {
    this.k = kernelFor(Math.round(fromRate), Math.round(toRate))
    const n = Math.max(0, span.outEnd - span.outStart)
    this.output = Array.from({ length: channels }, () => new Float32Array(n))
    const winLen = WINDOW_FRAMES + this.k.taps
    const mod = options.simd === false || !this.k.exact ? null : getSimdModule()
    if (mod) {
      // One memory per resampler, laid out once and never grown, so the views
      // below stay valid: the table, a window per channel, two output chunks.
      const tableBytes = this.k.table.length * 4
      const bytes = tableBytes + channels * winLen * 4 + 2 * SIMD_CHUNK * 4
      const mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 1 })
      const instance = new WebAssembly.Instance(mod, { env: { mem } })
      new Float32Array(mem.buffer, 0, this.k.table.length).set(this.k.table)
      const win = Array.from({ length: channels }, (_, ch) => tableBytes + ch * winLen * 4)
      const outBase = tableBytes + channels * winLen * 4
      const out: [number, number] = [outBase, outBase + SIMD_CHUNK * 4]
      this.window = win.map((at) => new Float32Array(mem.buffer, at, winLen))
      this.simd = {
        run: instance.exports.run as SimdRun,
        table: 0,
        win,
        out,
        outView: [new Float32Array(mem.buffer, out[0], SIMD_CHUNK), new Float32Array(mem.buffer, out[1], SIMD_CHUNK)],
      }
    } else {
      this.window = Array.from({ length: channels }, () => new Float32Array(winLen))
    }
    this.next = span.outStart
    this.winStart = this.firstInput(span.outStart)
    this.settled = this.winStart
  }

  /** The first input index output `m` reads. */
  private firstInput(m: number): number {
    return Math.floor((m * this.k.down) / this.k.up) - (this.k.half - 1)
  }

  /** The first input index the read needs at all: ask the decoder from here. */
  get inStart(): number {
    return Math.max(0, this.firstInput(this.span.outStart))
  }

  /** One past the last input index the read needs: stop the decoder here. */
  get inStop(): number {
    const { outStart, outEnd, inEnd } = this.span
    if (outEnd <= outStart) return this.inStart
    return Math.max(this.inStart, Math.min(inEnd, this.firstInput(outEnd - 1) + this.k.taps))
  }

  /**
   * Hand over `count` frames whose first frame is input index `at`. Returns false
   * once the input is past everything this read needs, so the caller can stop.
   */
  write(at: number, count: number, copy: FrameCopier): boolean {
    const stop = this.inStop
    // Nothing before input 0 is sound (an AAC track's priming sits there), and
    // nothing behind what is already settled may be written over.
    let skip = Math.max(0, -at, this.winStart - at, this.settled - at)
    while (skip < count) {
      const pos = at + skip
      if (pos >= stop || this.next >= this.span.outEnd) return false
      if (pos >= this.winStart + WINDOW_FRAMES) {
        // Everything before `pos` is final (a gap is silence), so compute what
        // that settles and make room.
        this.compute(pos)
        this.slide()
        continue
      }
      const n = Math.min(count - skip, this.winStart + WINDOW_FRAMES - pos, stop - pos)
      for (let ch = 0; ch < this.window.length; ch++) {
        copy(ch, this.window[ch]!.subarray(pos - this.winStart, pos - this.winStart + n), skip, n)
      }
      skip += n
      this.settled = pos + n
    }
    return at + count < stop
  }

  /** No more input is coming: what was never written is silence. */
  finish(): Float32Array[] {
    this.compute(Infinity)
    return this.output
  }

  /**
   * Compute every output whose taps are all settled (below `settledTo`, or past
   * the end of the input) and inside the window.
   */
  private compute(settledTo: number): void {
    const { up, down, taps, half } = this.k
    const { inEnd, outEnd } = this.span
    const winEnd = this.winStart + WINDOW_FRAMES + taps
    // Output m reads input [first, first + taps), first = floor(m * down / up) - half + 1.
    const reach = settledTo >= inEnd ? winEnd : Math.min(settledTo, winEnd)
    // The outputs whose last tap is below `reach`: floor(m * down / up) <= reach - half - 1.
    const k1 = reach - half
    const stop = Math.min(outEnd, k1 <= 0 ? 0 : Math.floor((k1 * up + down - 1) / down))
    if (stop <= this.next) return
    if (this.simd) this.convolveSimd(this.next, stop)
    else this.convolveJs(this.next, stop)
    this.next = stop
  }

  private convolveSimd(from: number, to: number): void {
    const s = this.simd!
    const { up, down, taps, half } = this.k
    const chans = this.window.length
    for (let m = from; m < to; m += SIMD_CHUNK) {
      const n = Math.min(SIMD_CHUNK, to - m)
      const num = m * down
      const r = num % up
      const x = (num - r) / up - (half - 1) - this.winStart
      const o = m - this.span.outStart
      for (let ch = 0; ch < chans; ch += 2) {
        const b = Math.min(ch + 1, chans - 1)
        s.run(n, x, r, s.win[ch]!, s.win[b]!, s.table, s.out[0], s.out[1], taps, up, down)
        this.output[ch]!.set(s.outView[0].subarray(0, n), o)
        if (b !== ch) this.output[b]!.set(s.outView[1].subarray(0, n), o)
      }
    }
  }

  private convolveJs(from: number, to: number): void {
    const { up, down, phases, exact, taps, half, table } = this.k
    const win = this.window
    const out = this.output
    for (let m = from; m < to; m++) {
      const num = m * down
      const r = num % up
      const base = (num - r) / up - (half - 1) - this.winStart
      let rowA: number
      let t = 0
      if (exact) rowA = r * taps
      else {
        const pos = (r / up) * phases
        const q = Math.floor(pos)
        t = pos - q
        rowA = q * taps
      }
      const o = m - this.span.outStart
      for (let ch = 0; ch < win.length; ch++) {
        const x = win[ch]!
        let s = dot(x, base, table, rowA, taps)
        if (t > 0) s += (dot(x, base, table, rowA + taps, taps) - s) * t
        out[ch]![o] = s
      }
    }
  }

  /** Drop the input no remaining output reads, and make room behind it. */
  private slide(): void {
    const keep = Math.max(this.winStart, this.firstInput(this.next))
    const shift = keep - this.winStart
    if (shift <= 0) {
      // A window that cannot slide is a bug, not a slow path: it would spin.
      throw new Error('resample: the input window is full and nothing in it is finished')
    }
    for (const x of this.window) {
      if (shift < x.length) {
        x.copyWithin(0, shift)
        x.fill(0, x.length - shift)
      } else x.fill(0)
    }
    this.winStart = keep
  }
}

/** The kernel's inner sum, in JS: two running sums so the adds do not all wait on one. */
function dot(x: Float32Array, xi: number, c: Float32Array, ci: number, taps: number): number {
  let a = 0
  let b = 0
  for (let j = 0; j < taps; j += 2) {
    a += x[xi + j]! * c[ci + j]!
    b += x[xi + j + 1]! * c[ci + j + 1]!
  }
  return a + b
}

/**
 * One channel from `fromRate` to `toRate`. Returns a new array and never
 * touches the input. `outLength` defaults to the input's length at the new rate,
 * and a round trip passes the original length back so it cannot drift by a
 * sample. Equal rates return a plain copy.
 */
export function resamplePlane(
  x: Float32Array,
  fromRate: number,
  toRate: number,
  outLength: number = Math.round((x.length * toRate) / fromRate),
): Float32Array {
  return resamplePlanes([x], fromRate, toRate, outLength)[0]!
}

/** Every channel at once: the same sums as `resamplePlane`, about twice as fast for stereo. */
export function resamplePlanes(
  planes: Float32Array[],
  fromRate: number,
  toRate: number,
  outLength: number = Math.round(((planes[0]?.length ?? 0) * toRate) / fromRate),
): Float32Array[] {
  const from = Math.round(fromRate)
  const to = Math.round(toRate)
  const len = Math.max(0, outLength)
  if (from === to) {
    return planes.map((x) => {
      const y = new Float32Array(len)
      y.set(x.subarray(0, len))
      return y
    })
  }
  const n = planes[0]?.length ?? 0
  const rs = new StreamResampler(from, to, planes.length, { inEnd: n, outStart: 0, outEnd: len })
  const start = rs.inStart
  rs.write(start, Math.max(0, n - start), (ch, dest, off, count) =>
    dest.set(planes[ch]!.subarray(start + off, start + off + count)),
  )
  return rs.finish()
}
