import { Download, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  canStreamToDisk,
  exportSequence,
  pickExportDestination,
  type ExportProgress,
  type ExportSettings,
} from '../engine/export'
import { losslessBitrate, youtubeBitrate } from '../engine/export/bitrate'
import { AV1_CODECS, HEVC_CODECS, type RateControl, type VideoCodecFamily } from '../engine/export/messages'
import { exportNative } from '../engine/export/nativeExport'
import { isElectron, olApi } from '../platform'
import type { NativeCaps, NativeEncoder } from '../../electron/ipc-types'
import { beginCriticalWork } from '../state/unloadGuard'
import { activeSequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { Button, IconButton } from '../ui/Button'

interface ResolutionPreset {
  /** Stable key used as the <option> value (survives reordering the list). */
  key: string
  label: string
  width: number
  height: number
}

/**
 * Largest even-dimension box that fits seq within (boxW×boxH), keeping aspect.
 * With `allowUpscale`, seq may be scaled UP to fill the box (for the "upload at a
 * higher resolution" YouTube presets); otherwise it only ever scales down.
 */
function evenFit(
  seqW: number,
  seqH: number,
  boxW: number,
  boxH: number,
  allowUpscale = false,
): { width: number; height: number } {
  const fit = Math.min(boxW / seqW, boxH / seqH)
  const s = allowUpscale ? fit : Math.min(1, fit)
  return {
    width: Math.max(2, Math.round((seqW * s) / 2) * 2),
    height: Math.max(2, Math.round((seqH * s) / 2) * 2),
  }
}

/**
 * Export presets PRESERVE the sequence aspect (so a 9:16 Shorts sequence exports
 * vertical, never stretched). Besides the sequence's native size and the classic
 * downscales, we offer 1440p/2160p UPSCALES: uploading a 1080p timeline as 2K/4K
 * escapes YouTube's bitrate-starved 1080p tier and looks markedly cleaner after
 * their re-encode (the well-known "upload higher-res for better 1080p" trick).
 * The upscales only appear when they actually raise the resolution.
 */
function buildResolutions(seqW: number, seqH: number): ResolutionPreset[] {
  const portrait = seqH > seqW
  const box = (w: number, h: number): [number, number] => (portrait ? [h, w] : [w, h])
  const full = evenFit(seqW, seqH, seqW, seqH)
  const twoK = evenFit(seqW, seqH, ...box(2560, 1440), true)
  const fourK = evenFit(seqW, seqH, ...box(3840, 2160), true)
  const hd = evenFit(seqW, seqH, ...box(1280, 720))
  const sd = evenFit(seqW, seqH, ...box(640, 360))
  const seqPx = full.width * full.height
  const bigger = (r: { width: number; height: number }): boolean => r.width * r.height > seqPx * 1.02

  const list: ResolutionPreset[] = [
    { key: 'seq', label: `Sequence (${full.width}×${full.height})`, ...full },
  ]
  if (bigger(twoK)) list.push({ key: '2k', label: `1440p, sharper on YouTube (${twoK.width}×${twoK.height})`, ...twoK })
  if (bigger(fourK)) list.push({ key: '4k', label: `2160p, best for YouTube (${fourK.width}×${fourK.height})`, ...fourK })
  list.push({ key: 'hd', label: `HD (${hd.width}×${hd.height})`, ...hd })
  list.push({ key: 'sd', label: `SD (${sd.width}×${sd.height})`, ...sd })
  return list
}

// The single "Quality" control. `cqp` (default) is constant-quality — the
// browser analogue of OBS Constant-QP that David records at, with a QP slider.
// The rest are bitrate-targeted (VBR): `youtube`/`max` compute their rate from
// the export raster at start(); the others are fixed. Kept as one dropdown (like
// CapCut) so the choice is one decision, not two.
type QualityKey = 'cqp' | 'youtube' | 'max' | 'high' | 'medium' | 'low'
const QUALITIES: { key: QualityKey; label: string; rate: RateControl; value: number | null }[] = [
  { key: 'cqp', label: 'Visually lossless (constant quality)', rate: 'quantizer', value: null },
  { key: 'youtube', label: 'YouTube (high quality)', rate: 'variable', value: null },
  { key: 'max', label: 'Maximum (near-lossless)', rate: 'variable', value: null },
  { key: 'high', label: 'High (24 Mbps)', rate: 'variable', value: 24_000_000 },
  { key: 'medium', label: 'Medium (12 Mbps)', rate: 'variable', value: 12_000_000 },
  { key: 'low', label: 'Low (5 Mbps)', rate: 'variable', value: 5_000_000 },
]

// QP slider bounds (H.264/HEVC scale, lower = better). 28 is a small, still-clean
// file; 12 is near-transparent.
const QP_MIN = 12
const QP_MAX = 28

// David records in OBS at H.264 Constant-QP 17 and won't change it, so the whole
// app anchors to that. The one-click tiers below all use his rate control (CQP)
// and codec (H.264): Highest preserves his capture most faithfully (the DEFAULT —
// "why would I ever pick lower"); Average re-encodes at his exact OBS QP; Lowest
// trades size for quality. One click sets every export field.
const OBS_QP = 17
type QualityTier = 'highest' | 'average' | 'lowest'
interface TierPreset {
  key: QualityTier
  label: string
  hint: string
  qp: number
  audioBitrate: number
}
const TIERS: TierPreset[] = [
  { key: 'highest', label: 'Highest', hint: 'Best — keeps your capture', qp: 14, audioBitrate: 320_000 },
  { key: 'average', label: 'Average', hint: 'Like your recording', qp: OBS_QP, audioBitrate: 256_000 },
  { key: 'lowest', label: 'Lowest', hint: 'Smallest file', qp: 22, audioBitrate: 192_000 },
]

const CODEC_LABELS: Record<VideoCodecFamily, string> = {
  avc: 'H.264 (universal)',
  hevc: 'H.265 / HEVC (smaller file)',
  av1: 'AV1 (smallest file)',
}

const FPS_CHOICES = [60, 50, 48, 30, 25, 24]

const AUDIO_BITRATES = [
  { value: 320_000, label: '320 kbps (transparent)' },
  { value: 256_000, label: '256 kbps' },
  { value: 192_000, label: '192 kbps' },
  { value: 128_000, label: '128 kbps' },
]

const KEYFRAME_INTERVALS = [
  { value: 2, label: '2 seconds (standard)' },
  { value: 1, label: '1 second' },
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
]

// Desktop-only: the native ffmpeg encoders. NVENC entries are hidden unless the
// probe confirms the GPU can encode them. `needs` maps to the probe's nvenc caps.
const NATIVE_ENCODERS: { key: NativeEncoder; label: string; needs?: 'h264' | 'hevc' | 'av1'; ext: string }[] = [
  { key: 'x264', label: 'H.264 · x264 veryslow (best quality)', ext: 'mp4' },
  { key: 'nvenc-h264', label: 'H.264 · GPU (NVENC, fast)', needs: 'h264', ext: 'mp4' },
  { key: 'x265', label: 'H.265 · x265 slow (smaller file)', ext: 'mp4' },
  { key: 'nvenc-hevc', label: 'H.265 · GPU (NVENC)', needs: 'hevc', ext: 'mp4' },
  { key: 'nvenc-av1', label: 'AV1 · GPU (NVENC, smallest)', needs: 'av1', ext: 'mp4' },
  { key: 'prores', label: 'ProRes 422 HQ (master / editing)', ext: 'mov' },
  { key: 'lossless', label: 'Lossless H.264 (huge files)', ext: 'mp4' },
]

// GPU is fast but some GPUs emit B-frames the muxer can't handle (the export
// crashes); software (openh264) never does. Auto uses the GPU and falls back to
// software only if it actually crashes - so most people get GPU speed and nobody
// hits the crash. The choice is remembered.
type EncoderMode = 'auto' | 'gpu' | 'software'
const ENCODER_KEY = 'reel:export:encoder'
const ENCODERS: { key: EncoderMode; label: string }[] = [
  { key: 'auto', label: 'Auto (GPU, else software)' },
  { key: 'gpu', label: 'GPU (fastest)' },
  { key: 'software', label: 'Software (most compatible)' },
]
function loadEncoderMode(): EncoderMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(ENCODER_KEY) : null
    return v === 'gpu' || v === 'software' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
function saveEncoderMode(m: EncoderMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ENCODER_KEY, m)
  } catch {
    // ignore storage failures
  }
}

// The rest of the export preferences persist as one small JSON blob.
const PREFS_KEY = 'reel:export:prefs'
interface ExportPrefs {
  qualityKey: QualityKey
  qp: number
  videoCodec: VideoCodecFamily
  keyframeIntervalS: number
  audioCodec: 'aac' | 'opus'
  audioBitrate: number
}
// Default = the Highest tier: David never wants a lower render quality out of the box.
const DEFAULT_PREFS: ExportPrefs = {
  qualityKey: 'cqp',
  qp: TIERS[0].qp,
  videoCodec: 'avc',
  keyframeIntervalS: 2,
  audioCodec: 'aac',
  audioBitrate: TIERS[0].audioBitrate,
}
function loadPrefs(): ExportPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<ExportPrefs>
    return {
      qualityKey: QUALITIES.some((q) => q.key === p.qualityKey) ? (p.qualityKey as QualityKey) : DEFAULT_PREFS.qualityKey,
      qp: typeof p.qp === 'number' ? Math.max(QP_MIN, Math.min(QP_MAX, p.qp)) : DEFAULT_PREFS.qp,
      videoCodec: p.videoCodec === 'hevc' || p.videoCodec === 'av1' ? p.videoCodec : 'avc',
      keyframeIntervalS: typeof p.keyframeIntervalS === 'number' ? p.keyframeIntervalS : DEFAULT_PREFS.keyframeIntervalS,
      audioCodec: p.audioCodec === 'opus' ? 'opus' : 'aac',
      audioBitrate: typeof p.audioBitrate === 'number' ? p.audioBitrate : DEFAULT_PREFS.audioBitrate,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}
function savePrefs(p: ExportPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // ignore storage failures
  }
}

/** The specific GPU-B-frame crash that a software retry fixes. */
export function isBFrameCrash(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /monotonically|Timestamps must be|\bDTS\b|B-?frame/i.test(m)
}

type Stage =
  | { kind: 'settings' }
  | { kind: 'running'; progress: ExportProgress; startedAt: number }
  /** `streamed` distinguishes "written where you chose" from "in your downloads". */
  | { kind: 'done'; sizeBytes: number; fileName: string; streamed: boolean }
  | { kind: 'error'; message: string }

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
}

/** A duration for the range picker: "4.5s" reads better than a full timecode here. */
function fmtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${Math.round(seconds - m * 60)}s`
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

const SELECT_CLS =
  'h-7 w-56 rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none disabled:opacity-40'
const ROW_CLS = 'flex items-center justify-between gap-3 text-[12px] text-text-secondary'

/** MP4 export is the one accent-primary flow in the app (spec §3). */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const seq = activeSequence(project)
  const show = useToasts((s) => s.show)

  const resolutions = buildResolutions(seq.width, seq.height)
  const [resolutionKey, setResolutionKey] = useState<string>(
    () => (resolutions.some((r) => r.key === '2k') ? '2k' : 'seq'),
  )
  const effectiveResolutionKey = resolutions.some((r) => r.key === resolutionKey) ? resolutionKey : 'seq'
  const preset = resolutions.find((r) => r.key === effectiveResolutionKey) ?? resolutions[0]

  const initialPrefs = useMemo(loadPrefs, [])
  const [qualityKey, setQualityKey] = useState<QualityKey>(initialPrefs.qualityKey)
  const [qp, setQp] = useState<number>(initialPrefs.qp)
  const [videoCodec, setVideoCodec] = useState<VideoCodecFamily>(initialPrefs.videoCodec)
  const [keyframeIntervalS, setKeyframeIntervalS] = useState<number>(initialPrefs.keyframeIntervalS)
  const [audioCodec, setAudioCodec] = useState<'aac' | 'opus'>(initialPrefs.audioCodec)
  const [audioBitrate, setAudioBitrate] = useState<number>(initialPrefs.audioBitrate)
  const [fpsChoice, setFpsChoice] = useState<'seq' | number>('seq')
  const [encoder, setEncoder] = useState<EncoderMode>(loadEncoderMode)
  // Which advanced codecs the machine can actually encode at this raster.
  const [codecSupport, setCodecSupport] = useState<{ hevc: boolean; av1: boolean }>({ hevc: false, av1: false })
  // Desktop-only: native ffmpeg encoder + probed capabilities.
  const [nativeEncoder, setNativeEncoder] = useState<NativeEncoder>('x264')
  const [nativeCaps, setNativeCaps] = useState<NativeCaps | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'settings' })
  const abortRef = useRef<AbortController | null>(null)

  const area = workArea(seq)
  const [useWorkArea, setUseWorkArea] = useState(area.active)
  const range = useWorkArea && area.active ? area : { startS: 0, endS: seq.durationS }

  const quality = QUALITIES.find((q) => q.key === qualityKey) ?? QUALITIES[0]
  const isCqp = quality.rate === 'quantizer'
  const exportFps = fpsChoice === 'seq' ? seq.fps : Math.min(fpsChoice, seq.fps)
  const fpsOptions = FPS_CHOICES.filter((f) => f < seq.fps)

  // Persist the whole preference set whenever it changes.
  useEffect(() => {
    savePrefs({ qualityKey, qp, videoCodec, keyframeIntervalS, audioCodec, audioBitrate })
  }, [qualityKey, qp, videoCodec, keyframeIntervalS, audioCodec, audioBitrate])

  // Probe which advanced codecs THIS machine can encode at the chosen raster, so
  // HEVC/AV1 only ever appear when they'll actually work (never a faked option).
  useEffect(() => {
    let alive = true
    const probeFamily = async (codecs: readonly string[], extra: VideoEncoderConfig | object): Promise<boolean> => {
      if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) return false
      for (const codec of codecs) {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec,
            width: preset.width,
            height: preset.height,
            framerate: exportFps,
            bitrate: 12_000_000,
            ...extra,
          } as VideoEncoderConfig)
          if (support.supported) return true
        } catch {
          // keep probing the ladder
        }
      }
      return false
    }
    void (async () => {
      const [hevc, av1] = await Promise.all([
        probeFamily(HEVC_CODECS, { hevc: { format: 'hevc' } }),
        probeFamily(AV1_CODECS, {}),
      ])
      if (alive) setCodecSupport({ hevc, av1 })
    })()
    return () => {
      alive = false
    }
  }, [preset.width, preset.height, exportFps])

  // If the chosen codec stops being supported (raster change), drop to H.264.
  useEffect(() => {
    if (videoCodec === 'hevc' && !codecSupport.hevc) setVideoCodec('avc')
    if (videoCodec === 'av1' && !codecSupport.av1) setVideoCodec('avc')
  }, [videoCodec, codecSupport])

  // Desktop only: ask the bundled ffmpeg + GPU what native encoders exist.
  useEffect(() => {
    if (!isElectron || !olApi) return
    let alive = true
    void olApi.nativeProbe().then((caps) => alive && setNativeCaps(caps))
    return () => {
      alive = false
    }
  }, [])

  const nativeEncoders = NATIVE_ENCODERS.filter((e) => !e.needs || nativeCaps?.nvenc[e.needs])
  const nativeExt = NATIVE_ENCODERS.find((e) => e.key === nativeEncoder)?.ext ?? 'mp4'

  useEffect(() => () => abortRef.current?.abort(), [])

  const fileName = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}.mp4`
  const running = stage.kind === 'running'

  useEffect(() => {
    if (running) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  // One-click tier: set every quality field from the OBS-anchored preset.
  const applyTier = (t: TierPreset) => {
    setQualityKey('cqp')
    setQp(t.qp)
    setVideoCodec('avc')
    setKeyframeIntervalS(2)
    setAudioCodec('aac')
    setAudioBitrate(t.audioBitrate)
  }
  // Which tier the current settings correspond to (null once anything is tweaked
  // off a preset), so the active tier stays highlighted.
  const activeTier: QualityTier | null =
    isCqp && videoCodec === 'avc' && audioCodec === 'aac' && keyframeIntervalS === 2
      ? TIERS.find((t) => t.qp === qp && t.audioBitrate === audioBitrate)?.key ?? null
      : null

  const start = async () => {
    // Bitrate is used by VBR modes AND as the fallback if the encoder can't honour
    // constant-QP — so CQP falls back to near-lossless VBR, still flawless.
    const videoBitrate = isCqp
      ? losslessBitrate(preset.width, preset.height, exportFps)
      : quality.value ??
        (quality.key === 'max'
          ? losslessBitrate(preset.width, preset.height, exportFps)
          : youtubeBitrate(preset.width, preset.height, exportFps))

    const settings: ExportSettings = {
      width: preset.width,
      height: preset.height,
      fps: exportFps,
      videoBitrate,
      startS: range.startS,
      endS: range.endS,
      rateControl: quality.rate,
      quantizer: qp,
      videoCodec,
      keyframeIntervalS,
      audioBitrate,
      audioCodecPref: audioCodec,
    }

    let handle: FileSystemFileHandle | null = null
    if (canStreamToDisk()) {
      try {
        handle = await pickExportDestination(fileName)
      } catch (err) {
        setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
      if (!handle) return
    }

    const abort = new AbortController()
    abortRef.current = abort
    const endCritical = beginCriticalWork()
    setStage({
      kind: 'running',
      progress: {
        phase: 'preparing',
        framesDone: 0,
        framesTotal: Math.ceil((range.endS - range.startS) * exportFps),
      },
      startedAt: performance.now(),
    })
    try {
      const runExport = (hw: 'prefer-hardware' | 'prefer-software') =>
        exportSequence(
          project,
          { ...settings, hardwareAcceleration: hw },
          (progress) => setStage((prev) => (prev.kind === 'running' ? { ...prev, progress } : prev)),
          abort.signal,
          handle ?? undefined,
        )

      let blob: Blob | null
      if (encoder === 'software') {
        blob = await runExport('prefer-software')
      } else if (encoder === 'gpu') {
        blob = await runExport('prefer-hardware')
      } else {
        try {
          blob = await runExport('prefer-hardware')
        } catch (err) {
          if (abort.signal.aborted || !isBFrameCrash(err)) throw err
          setStage((prev) =>
            prev.kind === 'running'
              ? { ...prev, progress: { ...prev.progress, phase: 'preparing', framesDone: 0 }, startedAt: performance.now() }
              : prev,
          )
          blob = await runExport('prefer-software')
        }
      }

      let sizeBytes: number
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
        sizeBytes = blob.size
      } else {
        sizeBytes = (await handle!.getFile()).size
      }
      const savedAs = handle?.name ?? fileName
      setStage({ kind: 'done', sizeBytes, fileName: savedAs, streamed: !!handle })
      show(`Exported ${savedAs} (${fmtBytes(sizeBytes)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStage({ kind: 'settings' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setStage({ kind: 'error', message })
      }
    } finally {
      endCritical()
    }
  }

  // Desktop: render with the shared pipeline, encode with the bundled ffmpeg (the
  // "maximum quality" path). The QP slider drives ffmpeg's -crf/-qp.
  const startNative = async () => {
    const baseName = project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'
    const settings: ExportSettings = {
      width: preset.width,
      height: preset.height,
      fps: exportFps,
      videoBitrate: 0,
      startS: range.startS,
      endS: range.endS,
    }
    const abort = new AbortController()
    abortRef.current = abort
    const endCritical = beginCriticalWork()
    setStage({
      kind: 'running',
      progress: { phase: 'preparing', framesDone: 0, framesTotal: Math.ceil((range.endS - range.startS) * exportFps) },
      startedAt: performance.now(),
    })
    try {
      const res = await exportNative(
        project,
        settings,
        { encoder: nativeEncoder, quality: qp, suggestedName: `${baseName}.${nativeExt}` },
        (progress) => setStage((prev) => (prev.kind === 'running' ? { ...prev, progress } : prev)),
        abort.signal,
      )
      if (res === null) {
        setStage({ kind: 'settings' }) // save dialog dismissed
        return
      }
      const savedAs = res.outPath.split(/[\\/]/).pop() ?? `${baseName}.${nativeExt}`
      setStage({ kind: 'done', sizeBytes: res.sizeBytes, fileName: savedAs, streamed: true })
      show(`Exported ${savedAs} (${fmtBytes(res.sizeBytes)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setStage({ kind: 'settings' })
      else setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      endCritical()
    }
  }

  const pct =
    stage.kind === 'running' && stage.progress.framesTotal > 0
      ? Math.min(100, Math.round((stage.progress.framesDone / stage.progress.framesTotal) * 100))
      : 0
  const eta =
    stage.kind === 'running' && stage.progress.framesDone > 3
      ? ((performance.now() - stage.startedAt) / 1000 / stage.progress.framesDone) *
        (stage.progress.framesTotal - stage.progress.framesDone)
      : NaN

  const someAdvancedCodec = codecSupport.hevc || codecSupport.av1

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        data-testid="export-dialog"
        className="flex max-h-[88vh] w-[440px] flex-col rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Export</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose} disabled={running}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        {stage.kind === 'settings' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <label className={ROW_CLS}>
              Range
              <select
                data-testid="export-range"
                aria-label="Export range"
                className={SELECT_CLS}
                value={useWorkArea ? 'workArea' : 'sequence'}
                disabled={!area.active}
                onChange={(e) => setUseWorkArea(e.target.value === 'workArea')}
              >
                <option value="sequence">Entire sequence ({fmtSeconds(seq.durationS)})</option>
                {area.active && (
                  <option value="workArea">Work area ({fmtSeconds(area.endS - area.startS)})</option>
                )}
              </select>
            </label>

            {/* Desktop: the native ffmpeg encoder (the maximum-quality path). */}
            {isElectron && (
              <label className={ROW_CLS}>
                Encoder
                <select
                  data-testid="export-native-encoder"
                  aria-label="Desktop encoder"
                  className={SELECT_CLS}
                  value={nativeEncoder}
                  onChange={(e) => setNativeEncoder(e.target.value as NativeEncoder)}
                >
                  {nativeEncoders.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Quality — the hero control (WebCodecs path, web only). */}
            {!isElectron && (
              <label className={ROW_CLS}>
                Quality
                <select
                  data-testid="export-bitrate"
                  aria-label="Quality"
                  className={SELECT_CLS}
                  value={qualityKey}
                  onChange={(e) => setQualityKey(e.target.value as QualityKey)}
                >
                  {QUALITIES.map((q) => (
                    <option key={q.key} value={q.key}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {(isCqp || isElectron) && (
              <div className="flex flex-col gap-1.5 rounded-field border border-border bg-bg-panel p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-text-secondary">Quality</span>
                  <span className="font-numeric text-text-primary" data-testid="export-qp-value">
                    QP {qp}
                    {qp === OBS_QP ? ' · like your recording' : ''}
                  </span>
                </div>
                <input
                  type="range"
                  data-testid="export-quantizer"
                  aria-label="Constant quality (QP)"
                  min={QP_MIN}
                  max={QP_MAX}
                  step={1}
                  value={qp}
                  onChange={(e) => setQp(Number(e.target.value))}
                  className="w-full accent-[var(--color-accent)]"
                />
                <div className="flex items-center justify-between text-[10px] text-text-muted">
                  <span>Visually lossless</span>
                  <span>Smaller file</span>
                </div>
              </div>
            )}

            {!isElectron && (
              <label className={ROW_CLS}>
                Codec
                <select
                  data-testid="export-codec"
                  aria-label="Video codec"
                  className={SELECT_CLS}
                  value={videoCodec}
                  onChange={(e) => setVideoCodec(e.target.value as VideoCodecFamily)}
                >
                  <option value="avc">{CODEC_LABELS.avc}</option>
                  {codecSupport.hevc && <option value="hevc">{CODEC_LABELS.hevc}</option>}
                  {codecSupport.av1 && <option value="av1">{CODEC_LABELS.av1}</option>}
                </select>
              </label>
            )}

            <label className={ROW_CLS}>
              Resolution
              <select
                data-testid="export-resolution"
                className={SELECT_CLS}
                value={effectiveResolutionKey}
                onChange={(e) => setResolutionKey(e.target.value)}
              >
                {resolutions.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className={ROW_CLS}>
              Frame rate
              <select
                data-testid="export-fps"
                aria-label="Frame rate"
                className={SELECT_CLS}
                value={String(fpsChoice)}
                onChange={(e) => setFpsChoice(e.target.value === 'seq' ? 'seq' : Number(e.target.value))}
              >
                <option value="seq">Sequence ({seq.fps} fps)</option>
                {fpsOptions.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>

            {!isElectron && (
              <label className={ROW_CLS}>
                Audio
                <span className="flex items-center gap-1.5">
                  <select
                    data-testid="export-audio-codec"
                    aria-label="Audio codec"
                    className="h-7 w-[92px] rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                    value={audioCodec}
                    onChange={(e) => setAudioCodec(e.target.value as 'aac' | 'opus')}
                  >
                    <option value="aac">AAC</option>
                    <option value="opus">Opus</option>
                  </select>
                  <select
                    data-testid="export-audio-bitrate"
                    aria-label="Audio bitrate"
                    className="h-7 w-[156px] rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                    value={audioBitrate}
                    onChange={(e) => setAudioBitrate(Number(e.target.value))}
                  >
                    {AUDIO_BITRATES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            )}

            {!isElectron && (
            <label className={ROW_CLS}>
              Keyframes
              <select
                data-testid="export-keyint"
                aria-label="Keyframe interval"
                className={SELECT_CLS}
                value={keyframeIntervalS}
                onChange={(e) => setKeyframeIntervalS(Number(e.target.value))}
              >
                {KEYFRAME_INTERVALS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            )}

            {!isElectron && (
              <label className={ROW_CLS}>
                Encoder
                <select
                  data-testid="export-encoder"
                  title="GPU is fastest; some GPUs crash the export, Software always works. Auto tries GPU, falls back to Software. Constant-quality always uses Software."
                  className={SELECT_CLS}
                  value={encoder}
                  onChange={(e) => {
                    const m = e.target.value as EncoderMode
                    setEncoder(m)
                    saveEncoderMode(m)
                  }}
                >
                  {ENCODERS.map((en) => (
                    <option key={en.key} value={en.key}>
                      {en.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex items-center justify-between text-[12px] text-text-secondary">
              <span>Format</span>
              <span className="text-text-primary">
                {isElectron
                  ? `${nativeExt.toUpperCase()} · ${exportFps} fps · ${fmtEta(range.endS - range.startS)}`
                  : `${videoCodec === 'avc' ? 'H.264' : videoCodec === 'hevc' ? 'H.265' : 'AV1'} MP4 · ${exportFps} fps · ${fmtEta(range.endS - range.startS)}`}
              </span>
            </div>

            <p className="text-[11px] leading-4 text-text-muted">
              {isElectron
                ? 'Encoded with a bundled ffmpeg — a real x264/x265/NVENC/ProRes encoder. Slower than the browser, flawless quality. Your footage never leaves this machine.'
                : 'Encoded locally with WebCodecs; your footage never leaves this machine.'}
              {!isElectron && isCqp && ' Constant quality uses the software encoder for a faithful, capture-grade file — it trades speed for quality.'}
            </p>
            {effectiveResolutionKey === '2k' || effectiveResolutionKey === '4k' ? (
              <p className="text-[11px] leading-4 text-accent">
                Uploading at a higher resolution than your timeline makes YouTube encode it in
                its higher-bitrate tier: noticeably cleaner, even watched at 1080p.
              </p>
            ) : null}
            {!isElectron && !someAdvancedCodec ? (
              <p className="text-[11px] leading-4 text-text-muted">
                H.265 / AV1 appear here when your GPU can encode them (smaller files at the same quality).
              </p>
            ) : null}

            {/* One-click quality tiers — sets every field above from the OBS
                reference. This is the "just pick one and go" control. */}
            <div className="mt-1 flex flex-col gap-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-secondary">Quality preset</span>
                <span className="text-[10px] text-text-muted">sets everything from your recording</span>
              </div>
              <div className="flex gap-1.5" data-testid="export-tier" role="group" aria-label="Quality preset">
                {TIERS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    data-testid={`export-tier-${t.key}`}
                    aria-pressed={activeTier === t.key}
                    onClick={() => applyTier(t)}
                    className={`flex flex-1 flex-col items-center gap-0.5 rounded-field border px-2 py-2 transition-colors duration-[120ms] ${
                      activeTier === t.key
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border bg-bg-input text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <span className="text-[12px] font-semibold">{t.label}</span>
                    <span className={`text-[10px] ${activeTier === t.key ? 'text-accent-fg opacity-80' : 'text-text-muted'}`}>
                      {t.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-1 flex shrink-0 justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="export-start"
                onClick={() => void (isElectron ? startNative() : start())}
                disabled={seq.durationS <= 0}
              >
                <Download size={16} strokeWidth={1.5} />
                Export
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'running' && (
          <div className="flex flex-col gap-3 p-4" data-testid="export-progress">
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-1.5 capitalize text-ember">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" aria-hidden />
                {stage.progress.phase}…
              </span>
              <span className="font-numeric text-text-primary">{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-input">
              <div
                className="h-full rounded-full bg-ember transition-[width] duration-[120ms] ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between font-numeric text-[11px] text-text-muted">
              <span>
                {stage.progress.framesDone} / {stage.progress.framesTotal} frames
              </span>
              <span>ETA {fmtEta(eta)}</span>
            </div>
            <div className="mt-1 flex justify-end">
              <Button
                variant="secondary"
                data-testid="export-cancel"
                onClick={() => abortRef.current?.abort()}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[13px] text-text-primary">
              Saved <span className="font-medium">{stage.fileName}</span>{' '}
              <span className="text-text-secondary">({fmtBytes(stage.sizeBytes)})</span>{' '}
              {stage.streamed ? 'where you chose.' : 'to your downloads.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setStage({ kind: 'settings' })}>
                Export again
              </Button>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[12px] leading-5 text-danger">{stage.message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={() => setStage({ kind: 'settings' })}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
