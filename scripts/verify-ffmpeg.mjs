// Prove a candidate ffmpeg.exe can do everything OL Premiere actually asks of it.
//
// Why this exists: the bundled ffmpeg is a full 137.9 MB build carrying AV1
// encoders, VVC, Blu-ray, DVD, ZeroMQ, LV2, OpenAL, SDL2 and Vulkan that this
// app never touches. Stripping it to a minimal build is the plan (D40), and the
// failure mode of a stripped build is a MISSING ENCODER, which shows up as an
// export that dies seconds in. So: before any swap, run every export path this
// app can emit against the candidate binary and look at real exit codes.
//
// It imports buildArgs from electron/exportArgs.ts rather than restating the
// arguments, so this check can never quietly drift from the shipping code.
//
// Usage:
//   npm run verify:ffmpeg                      (the vendored binary)
//   npm run verify:ffmpeg -- path/to/ffmpeg.exe
//
// Deliberately NOT checked: whether the output file decodes again. A minimal
// build is expected to drop the h264/hevc DECODERS it never needs, so decoding
// the result would fail a good binary. Exit code plus a non-empty file is the
// honest gate.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Node needs --experimental-strip-types to import the .ts arg builder. Re-exec
// once with it rather than making the caller remember, so a bare `node
// scripts/verify-ffmpeg.mjs` behaves the same as the npm script.
if (!process.execArgv.some((a) => a.startsWith('--experimental-strip-types'))) {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(r.status ?? 1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// pathToFileURL, because a bare Windows absolute path is not a legal ESM specifier.
const { buildArgs, NATIVE_ENCODERS, NVENC_ENCODERS, containerExt } = await import(
  pathToFileURL(path.join(root, 'electron', 'exportArgs.ts')).href
)

const candidate = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')

if (!existsSync(candidate)) {
  console.error(`FAIL: no ffmpeg at ${candidate}`)
  process.exit(1)
}

// A real export is 1920x1080+, but nothing here is resolution sensitive and a
// small frame keeps the whole sweep under a minute. Even dimensions only, since
// yuv420p cannot represent odd ones.
const W = 320
const H = 240
const FPS = 30
const FRAMES = 12
const SAMPLE_RATE = 48_000

// What the app can REACH today. exportPlan.ts pins EXPORT_NATIVE_ENCODER to
// 'x264' and nothing ever overrides it, so x264 plus aac is the whole shipping
// surface. Missing any of this breaks the only export a user can actually run,
// so this list, and only this list, decides red or green.
const REQUIRED = {
  encoders: ['libx264', 'aac'],
  decoders: ['rawvideo', 'pcm_f32le'],
  demuxers: ['rawvideo', 'wav'],
  muxers: ['mp4'],
  filters: ['vflip', 'scale'],
}

// Carried by the current full build and exercised by the sweep below, but NOT
// reachable from the UI: videoEncoderArgs has a case for each, yet no code path
// sets config.encoder to anything but 'x264'. A minimal build is EXPECTED to drop
// these, so their absence is reported and must never fail the check. Failing on
// them would flunk a correct minimal build, which is the opposite of a useful gate.
const UNREACHABLE_ENCODERS = new Set(['x265', 'nvenc-h264', 'nvenc-hevc', 'nvenc-av1', 'prores', 'lossless'])
const OPTIONAL_NAMES = { encoders: ['libx265', 'prores_ks', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc'], muxers: ['mov'] }

function run(args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(candidate, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d.length > 200_000 ? '' : d))
    p.stdin.on('error', () => {})
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    p.on('close', (code) => resolve({ code, out, err }))
    if (stdin) {
      stdin(p.stdin)
    } else {
      p.stdin.end()
    }
  })
}

/** The interleaved 32-bit float WAV the app writes as ffmpeg's second input. */
function buildWavF32(seconds, channels = 2) {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const dataBytes = frames * channels * 4
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20) // IEEE float
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * channels * 4, 28)
  buf.writeUInt16LE(channels * 4, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  let o = 44
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((f / SAMPLE_RATE) * 440 * 2 * Math.PI) * 0.25
    for (let c = 0; c < channels; c++) {
      buf.writeFloatLE(v, o)
      o += 4
    }
  }
  return buf
}

/** One RGBA frame, a moving gradient so the encoder has real work to do. */
function rgbaFrame(i) {
  const buf = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      buf[o] = (x + i * 8) & 0xff
      buf[o + 1] = (y + i * 4) & 0xff
      buf[o + 2] = (x + y) & 0xff
      buf[o + 3] = 255
    }
  }
  return buf
}

async function main() {
  const sizeMB = statSync(candidate).size / 1024 / 1024
  console.log(`ffmpeg   ${candidate}`)
  console.log(`size     ${sizeMB.toFixed(1)} MB`)

  const ver = await run(['-hide_banner', '-version'])
  if (ver.code !== 0) {
    console.error('FAIL: the binary will not even report its version')
    process.exit(1)
  }
  console.log(`version  ${(ver.out.split(/\r?\n/)[0] || '').replace('ffmpeg version ', '')}`)
  console.log()

  // -- capability surface ----------------------------------------------------
  const lists = {
    encoders: (await run(['-hide_banner', '-encoders'])).out,
    decoders: (await run(['-hide_banner', '-decoders'])).out,
    demuxers: (await run(['-hide_banner', '-demuxers'])).out,
    muxers: (await run(['-hide_banner', '-muxers'])).out,
    filters: (await run(['-hide_banner', '-filters'])).out,
  }
  const missing = []
  for (const [kind, names] of Object.entries(REQUIRED)) {
    for (const n of names) {
      const present = new RegExp(`\\b${n}\\b`).test(lists[kind])
      if (!present) missing.push(`${kind}: ${n}`)
    }
  }
  console.log(`required capabilities  ${missing.length === 0 ? 'all present' : `MISSING ${missing.length}`}`)
  for (const m of missing) console.log(`  MISSING  ${m}`)
  const carried = []
  for (const [kind, names] of Object.entries(OPTIONAL_NAMES)) {
    for (const n of names) if (new RegExp(`\\b${n}\\b`).test(lists[kind])) carried.push(n)
  }
  console.log(`unreachable extras carried  ${carried.length ? carried.join(', ') : 'none'}`)
  if (carried.length) console.log('  (weight this build carries for code paths the UI cannot select)')
  console.log()

  // -- every real export path ------------------------------------------------
  const dir = await mkdtemp(path.join(tmpdir(), 'olp-ffcheck-'))
  const wavPath = path.join(dir, 'audio.wav')
  await writeFile(wavPath, buildWavF32(FRAMES / FPS))

  const results = []
  for (const encoder of NATIVE_ENCODERS) {
    const outPath = path.join(dir, `out-${encoder}.${containerExt(encoder)}`)
    const config = {
      width: W,
      height: H,
      fps: FPS,
      totalFrames: FRAMES,
      encoder,
      quality: 20,
      hasAudio: true,
      outPath,
      suggestedName: 'check',
    }
    const args = buildArgs(config, wavPath, outPath)
    const t0 = Date.now()
    const r = await run(args, {
      stdin: (sin) => {
        let i = 0
        const pump = () => {
          while (i < FRAMES) {
            const ok = sin.write(rgbaFrame(i++))
            if (!ok) return sin.once('drain', pump)
          }
          sin.end()
        }
        pump()
      },
    })
    let bytes = 0
    try {
      bytes = (await stat(outPath)).size
    } catch {
      bytes = 0
    }
    const reachable = !UNREACHABLE_ENCODERS.has(encoder)
    const ok = r.code === 0 && bytes > 0
    results.push({ encoder, ok, reachable, gpu: NVENC_ENCODERS.has(encoder), code: r.code, bytes, ms: Date.now() - t0, err: r.err })
  }

  for (const r of results) {
    const status = r.ok ? 'ok   ' : r.reachable ? 'FAIL ' : 'n/a  '
    const tag = r.reachable ? ' <- the shipping path' : ''
    const detail = r.ok
      ? `${(r.bytes / 1024).toFixed(0)} KB in ${r.ms} ms`
      : `${r.err.split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${r.code}`}`
    console.log(`${status}${r.encoder.padEnd(11)}${detail}${tag}`)
  }
  await rm(dir, { recursive: true, force: true })

  const hardFails = results.filter((r) => !r.ok && r.reachable)
  console.log()
  console.log('Only x264 is reachable (exportPlan.ts EXPORT_NATIVE_ENCODER). The rows marked n/a are')
  console.log('code paths the UI cannot select, so they never decide this result either way.')
  if (hardFails.length || missing.length) {
    console.log(`RED: ${hardFails.length} reachable export path(s) broken, ${missing.length} capability gap(s).`)
    console.log('This binary cannot ship.')
    process.exit(1)
  }
  console.log('GREEN: the export this app actually runs works on this binary.')
}

await main()
