/// <reference lib="webworker" />
// Export renderer (spec §5): demux/decode source video with mediabunny,
// composite every output frame onto one OffscreenCanvas, encode with
// WebCodecs, mux with mp4-muxer. Everything heavy happens in this module
// worker; the main thread only relays progress.

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import type { InputVideoTrack, WrappedCanvas } from 'mediabunny'
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { clipEndS } from '../timeline'
import type { Clip, Id } from '../types'
import {
  AUDIO_CHUNK_FRAMES,
  H264_CODECS,
  clipFrameRange,
  containRect,
  firstSupported,
  packPlanarChunk,
  pcmChunks,
  type ExportRequest,
  type ExportResponse,
} from './messages'

const scope = self as unknown as DedicatedWorkerGlobalScope

const post = (msg: ExportResponse, transfer: Transferable[] = []): void => scope.postMessage(msg, transfer)

class CancelledError extends Error {}

let cancelled = false
let started = false

scope.onmessage = (e: MessageEvent<ExportRequest>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelled = true
  } else if (!started) {
    started = true
    void run(msg)
  }
}

const checkCancel = (): void => {
  if (cancelled) throw new CancelledError('cancelled')
}

// The encoder queue limit for backpressure; keeps decoded frames bounded.
const MAX_ENCODE_QUEUE = 4

// 'dequeue' can fire between reading encodeQueueSize and adding the listener,
// so a short timeout race keeps the drain loop from hanging on that edge.
const nextDequeue = (enc: VideoEncoder | AudioEncoder): Promise<void> =>
  new Promise((resolve) => {
    // done only runs via the timer or the listener, both set up below, so
    // reading `timer` inside it never hits the TDZ.
    const done = (): void => {
      clearTimeout(timer)
      enc.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, 50)
    enc.addEventListener('dequeue', done, { once: true })
  })

function drawContain(
  c2d: OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  opacity: number,
): void {
  const rect = containRect(srcW, srcH, dstW, dstH)
  if (!rect) return
  c2d.globalAlpha = Math.max(0, Math.min(1, opacity))
  c2d.drawImage(source, rect.x, rect.y, rect.w, rect.h)
  c2d.globalAlpha = 1
}

// Source frames rarely land exactly on the output grid (variable-frame-rate
// captures, mismatched fps), so each video layer walks a SEQUENTIAL canvases()
// iterator and holds the newest frame whose timestamp <= wanted source time —
// classic pull-down. canvasesAtTimestamps() is unsuitable here: it yields null
// whenever a requested grid time has no exact frame.
type Layer =
  | { kind: 'image'; clip: Clip; first: number; end: number; bitmap: ImageBitmap }
  | {
      kind: 'video'
      clip: Clip
      first: number
      end: number
      speed: number
      iterator: AsyncGenerator<WrappedCanvas, void, unknown>
      started: boolean
      /** Newest frame with timestamp <= current source time. */
      current: WrappedCanvas | null
      /** Next decoded frame, not yet due. */
      ahead: WrappedCanvas | null
    }

const SRC_TIME_EPS_S = 1e-4

async function run(init: Extract<ExportRequest, { type: 'init' }>): Promise<void> {
  const cleanups: (() => void)[] = []
  let stage = 'preparing'
  try {
    const { settings, sequence, assets, audio } = init
    const framesTotal = Math.max(1, Math.ceil(sequence.durationS * settings.fps))
    post({ type: 'progress', progress: { phase: 'preparing', framesDone: 0, framesTotal } })

    // --- codec picks -------------------------------------------------------
    stage = 'probing encoder support'
    const videoConfigFor = (codec: string): VideoEncoderConfig => ({
      codec,
      width: settings.width,
      height: settings.height,
      bitrate: settings.videoBitrate,
      framerate: settings.fps,
      latencyMode: 'quality',
    })
    const videoCodec = await firstSupported([...H264_CODECS], async (codec) => {
      const support = await VideoEncoder.isConfigSupported(videoConfigFor(codec))
      return support.supported === true
    })
    if (!videoCodec) {
      throw new Error(
        `no H.264 (avc1) encoder available for ${settings.width}x${settings.height}@${settings.fps} — try a smaller frame size`,
      )
    }

    let audioCodec: 'aac' | 'opus' | null = null
    let audioConfig: AudioEncoderConfig | null = null
    if (audio) {
      const base = {
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.numberOfChannels,
        bitrate: 192_000,
      }
      const aac = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', ...base })
      if (aac.supported) {
        audioCodec = 'aac'
        audioConfig = { codec: 'mp4a.40.2', ...base }
      } else {
        const opus = await AudioEncoder.isConfigSupported({ codec: 'opus', ...base })
        if (opus.supported) {
          audioCodec = 'opus'
          audioConfig = { codec: 'opus', ...base }
        }
        // Neither AAC nor Opus: ship a video-only file instead of failing.
      }
    }

    // --- muxer + encoders --------------------------------------------------
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      fastStart: 'in-memory',
      video: { codec: 'avc', width: settings.width, height: settings.height, frameRate: settings.fps },
      audio:
        audio && audioCodec
          ? { codec: audioCodec, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate }
          : undefined,
    })

    let encoderError: Error | null = null
    const throwIfFailed = (): void => {
      if (encoderError) throw encoderError
    }
    const drain = async (enc: VideoEncoder | AudioEncoder): Promise<void> => {
      while (enc.encodeQueueSize > MAX_ENCODE_QUEUE) {
        checkCancel()
        throwIfFailed()
        await nextDequeue(enc)
      }
    }

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encoderError ??= new Error(`video encoding failed: ${e.message}`)
      },
    })
    videoEncoder.configure(videoConfigFor(videoCodec))
    cleanups.push(() => {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    })

    // --- audio encode ------------------------------------------------------
    if (audio && audioConfig) {
      stage = 'encoding audio'
      post({ type: 'progress', progress: { phase: 'audio', framesDone: 0, framesTotal } })
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          encoderError ??= new Error(`audio encoding failed: ${e.message}`)
        },
      })
      audioEncoder.configure(audioConfig)
      cleanups.push(() => {
        if (audioEncoder.state !== 'closed') audioEncoder.close()
      })

      const totalFrames = audio.channelData[0]?.length ?? 0
      for (const chunk of pcmChunks(totalFrames, AUDIO_CHUNK_FRAMES, audio.sampleRate)) {
        checkCancel()
        throwIfFailed()
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audio.sampleRate,
          numberOfFrames: chunk.frames,
          numberOfChannels: audio.numberOfChannels,
          timestamp: chunk.timestampUs,
          data: packPlanarChunk(audio.channelData, chunk.offset, chunk.frames),
        })
        audioEncoder.encode(data)
        data.close()
        await drain(audioEncoder)
      }
      await audioEncoder.flush()
      throwIfFailed()
    }

    // --- open media --------------------------------------------------------
    stage = 'opening media'
    const assetById = new Map(assets.map((a) => [a.id, a]))
    const videoTracks = new Map<Id, InputVideoTrack | null>()
    const bitmaps = new Map<Id, ImageBitmap>()
    for (const asset of assets) {
      checkCancel()
      if (asset.kind === 'video') {
        const input = new Input({ source: new BlobSource(asset.blob), formats: ALL_FORMATS })
        cleanups.push(() => input.dispose())
        try {
          videoTracks.set(asset.id, await input.getPrimaryVideoTrack())
        } catch (err) {
          throw new Error(`could not read video "${asset.name}": ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (asset.kind === 'image') {
        try {
          const bitmap = await createImageBitmap(asset.blob)
          bitmaps.set(asset.id, bitmap)
          cleanups.push(() => bitmap.close())
        } catch {
          throw new Error(`could not decode image "${asset.name}"`)
        }
      }
    }

    // --- build layers ------------------------------------------------------
    // seq.tracks keeps video tracks bottom→top, so layer order here IS draw
    // order; clips never overlap within a track, so at most one layer per
    // track is active at any output frame.
    const layers: Layer[] = []
    for (const track of sequence.tracks) {
      if (track.kind !== 'video' || track.muted) continue
      for (const clip of track.clips) {
        if (!clip.enabled) continue
        const asset = assetById.get(clip.assetId)
        if (!asset) continue
        const { first, end } = clipFrameRange(clip.startS, clipEndS(clip), settings.fps)
        if (first >= end) continue
        if (asset.kind === 'image') {
          const bitmap = bitmaps.get(asset.id)
          if (bitmap) layers.push({ kind: 'image', clip, first, end, bitmap })
        } else if (asset.kind === 'video') {
          const track2 = videoTracks.get(asset.id)
          if (!track2) continue // no decodable video track → contributes nothing
          // One CanvasSink per CLIP, not per asset: canvasesAtTimestamps only
          // hits its decode-each-packet-once fast path when the timestamp
          // stream is monotone. Source times only ever increase WITHIN a clip
          // (speed is constant, playback is forward), but different clips can
          // revisit earlier source times, so sharing a sink/iterator across
          // clips would break monotonicity. CanvasSink over VideoSampleSink
          // because compositing needs a 2D-drawable (rotation + color
          // conversion handled for us); poolSize bounds VRAM.
          // poolSize 3: we hold up to two frames (current + ahead) while a
          // third gets decoded into the pool.
          const sink = new CanvasSink(track2, { poolSize: 3 })
          const speed = Math.abs(clip.speed || 1)
          layers.push({
            kind: 'video',
            clip,
            first,
            end,
            speed,
            iterator: sink.canvases(clip.inS, clip.outS + 1 / settings.fps),
            started: false,
            current: null,
            ahead: null,
          })
        }
      }
    }

    // --- render + encode video ---------------------------------------------
    stage = 'rendering video'
    const canvas = new OffscreenCanvas(settings.width, settings.height)
    const c2d = canvas.getContext('2d')
    if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable')

    const keyEvery = Math.max(1, Math.round(settings.fps * 2))
    for (let f = 0; f < framesTotal; f++) {
      checkCancel()
      throwIfFailed()
      c2d.globalAlpha = 1
      c2d.fillStyle = '#000'
      c2d.fillRect(0, 0, settings.width, settings.height)

      for (const layer of layers) {
        if (f < layer.first || f >= layer.end) continue
        if (layer.kind === 'image') {
          drawContain(
            c2d,
            layer.bitmap,
            layer.bitmap.width,
            layer.bitmap.height,
            settings.width,
            settings.height,
            layer.clip.opacity,
          )
        } else {
          const srcT = layer.clip.inS + (f / settings.fps - layer.clip.startS) * layer.speed
          if (!layer.started) {
            layer.started = true
            const r = await layer.iterator.next()
            layer.ahead = r.done ? null : r.value
          }
          while (layer.ahead && layer.ahead.timestamp <= srcT + SRC_TIME_EPS_S) {
            layer.current = layer.ahead
            const r = await layer.iterator.next()
            layer.ahead = r.done ? null : r.value
          }
          // Before the first packet: clamp to it. Past the last: freeze on it.
          const wrapped = layer.current ?? layer.ahead
          if (wrapped) {
            drawContain(
              c2d,
              wrapped.canvas,
              wrapped.canvas.width,
              wrapped.canvas.height,
              settings.width,
              settings.height,
              layer.clip.opacity,
            )
          }
        }
      }

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((f * 1e6) / settings.fps),
        duration: Math.round(1e6 / settings.fps),
      })
      videoEncoder.encode(frame, { keyFrame: f % keyEvery === 0 })
      frame.close()
      await drain(videoEncoder)

      if ((f + 1) % 5 === 0 || f + 1 === framesTotal) {
        post({ type: 'progress', progress: { phase: 'video', framesDone: f + 1, framesTotal } })
      }
    }

    await videoEncoder.flush()
    throwIfFailed()

    // --- finalize ----------------------------------------------------------
    stage = 'finalizing'
    post({ type: 'progress', progress: { phase: 'finalizing', framesDone: framesTotal, framesTotal } })
    muxer.finalize()
    const { buffer } = muxer.target
    post({ type: 'done', buffer }, [buffer])
  } catch (err) {
    if (err instanceof CancelledError || cancelled) {
      post({ type: 'cancelled' })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      post({ type: 'error', message: `Export failed while ${stage}: ${message}` })
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        // best-effort teardown
      }
    }
  }
}
