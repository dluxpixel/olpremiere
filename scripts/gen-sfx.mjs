// Generates the bundled SFX pack: small, original, procedurally-synthesized
// stingers (whoosh / boom / hit / ding / ...) written as 48kHz 16-bit mono
// WAVs into public/sfx/, plus src/engine/sfx/manifest.json describing them.
// Everything is synthesized from scratch here — no samples, no licensing tail.
// Deterministic (seeded PRNG), so re-running reproduces byte-identical files.
//
//   node scripts/gen-sfx.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'sfx')
const MANIFEST = join(ROOT, 'src', 'engine', 'sfx', 'manifest.json')

const SR = 48000

// --- tiny DSP toolkit -------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** RBJ bandpass biquad, coefficients re-derived per sample for sweeps. */
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x, fc, q) => {
    const w = (2 * Math.PI * Math.min(fc, SR * 0.45)) / SR
    const alpha = Math.sin(w) / (2 * q)
    const b0 = alpha, b1 = 0, b2 = -alpha
    const a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha
    const y = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

const expSweep = (from, to, t, durS) => from * Math.pow(to / from, Math.min(1, t / durS))
const softClip = (x, drive) => Math.tanh(x * drive) / Math.tanh(drive)

/** Normalize to a healthy peak and fade the tail to zero (anti-click). */
function finalize(buf, peak = 0.89) {
  let max = 1e-9
  for (const v of buf) max = Math.max(max, Math.abs(v))
  const g = peak / max
  const fade = Math.min(buf.length, Math.round(SR * 0.008))
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= g
    if (i >= buf.length - fade) buf[i] *= (buf.length - i) / fade
  }
  return buf
}

function render(durS, fn) {
  const n = Math.round(durS * SR)
  const buf = new Float64Array(n)
  fn(buf, n)
  return finalize(buf)
}

// --- the sounds --------------------------------------------------------------

const SOUNDS = [
  {
    id: 'whoosh',
    name: 'Whoosh',
    durS: 0.5,
    gen: (buf, n) => {
      const rnd = rng(11)
      const bp = bandpass()
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const p = i / n
        const fc = expSweep(500, 2800, t, n / SR)
        const env = Math.sin(Math.PI * Math.pow(p, 0.75)) ** 2
        buf[i] = bp((rnd() * 2 - 1) * env, fc, 1.2) * 2.5
      }
    },
  },
  {
    id: 'boom',
    name: 'Deep Boom',
    durS: 1.2,
    gen: (buf, n) => {
      const rnd = rng(22)
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const f = expSweep(85, 36, t, 0.35)
        phase += (2 * Math.PI * f) / SR
        const body = Math.sin(phase) * Math.exp(-t / 0.35)
        const thump = t < 0.06 ? (rnd() * 2 - 1) * Math.exp(-t / 0.015) * 0.4 : 0
        buf[i] = softClip(body + thump, 2.2)
      }
    },
  },
  {
    id: 'hit',
    name: 'Hit Marker',
    durS: 0.14,
    gen: (buf, n) => {
      const rnd = rng(33)
      const bp = bandpass()
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const noise = bp((rnd() * 2 - 1) * Math.exp(-t / 0.02), 1800, 0.9) * 2
        const ping = Math.sin(2 * Math.PI * 1250 * t) * Math.exp(-t / 0.03) * 0.7
        buf[i] = noise + ping
      }
    },
  },
  {
    id: 'ding',
    name: 'Level Ding',
    durS: 0.9,
    gen: (buf, n) => {
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const shimmer = 1 + 0.002 * Math.sin(2 * Math.PI * 5.2 * t)
        buf[i] =
          (Math.sin(2 * Math.PI * 1319 * shimmer * t) +
            0.35 * Math.sin(2 * Math.PI * 2637 * t) +
            0.15 * Math.sin(2 * Math.PI * 3951 * t)) *
          Math.exp(-t / 0.22)
      }
    },
  },
  {
    id: 'pop',
    name: 'Pop',
    durS: 0.1,
    gen: (buf, n) => {
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / SR
        phase += (2 * Math.PI * expSweep(340, 150, t, 0.1)) / SR
        buf[i] = softClip(Math.sin(phase) * Math.exp(-t / 0.03), 1.6)
      }
    },
  },
  {
    id: 'riser',
    name: 'Riser',
    durS: 1.4,
    gen: (buf, n) => {
      const rnd = rng(55)
      const bp = bandpass()
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const p = i / n
        const fc = expSweep(350, 6500, t, n / SR)
        buf[i] = bp((rnd() * 2 - 1) * Math.pow(p, 1.6), fc, 1.4) * 2.5
      }
    },
  },
  {
    id: 'subdrop',
    name: 'Sub Drop',
    durS: 0.8,
    gen: (buf, n) => {
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / SR
        phase += (2 * Math.PI * expSweep(170, 30, t, 0.55)) / SR
        const tail = Math.min(1, (0.8 - t) / 0.15)
        buf[i] = softClip(Math.sin(phase), 1.6) * tail
      }
    },
  },
  {
    id: 'zap',
    name: 'Zap',
    durS: 0.3,
    gen: (buf, n) => {
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const vib = 1 + 0.3 * Math.sin(2 * Math.PI * 40 * t)
        phase += (2 * Math.PI * expSweep(1700, 220, t, 0.3) * vib) / SR
        buf[i] = softClip(Math.sin(phase), 3) * Math.exp(-t / 0.09)
      }
    },
  },
  {
    id: 'tick',
    name: 'Tick',
    durS: 0.06,
    gen: (buf, n) => {
      const rnd = rng(88)
      const bp = bandpass()
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const src = (i === 0 ? 1 : 0) + (t < 0.005 ? (rnd() * 2 - 1) * 0.6 : 0)
        buf[i] = bp(src * Math.exp(-t / 0.01), 3500, 2) * 4
      }
    },
  },
]

// --- WAV encode ---------------------------------------------------------------

function toWav(buf) {
  const n = buf.length
  const bytes = new ArrayBuffer(44 + n * 2)
  const v = new DataView(bytes)
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]))
    v.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return Buffer.from(bytes)
}

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(dirname(MANIFEST), { recursive: true })

const manifest = []
for (const s of SOUNDS) {
  const wav = toWav(render(s.durS, s.gen))
  const file = `${s.id}.wav`
  writeFileSync(join(OUT_DIR, file), wav)
  manifest.push({ id: s.id, name: s.name, file, durationS: s.durS })
  console.log(`${file}  ${(wav.length / 1024).toFixed(0)} KB  ${s.durS}s`)
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
console.log(`manifest → ${MANIFEST}`)
