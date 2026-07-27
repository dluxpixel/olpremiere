// Probe a File with browser media elements before it enters the project:
// kind, duration, dimensions, audio presence, and a poster thumbnail.
// Phase 3 (WebCodecs demux) replaces the audio-detection heuristics here.

export interface ProbeResult {
  kind: 'video' | 'audio' | 'image'
  durationS: number
  width?: number
  height?: number
  hasAudio: boolean
  hasVideo: boolean
  thumbnailBlob?: Blob
}

const WAIT_MS = 10_000
const THUMB_W = 320
const THUMB_H = 180

/** Wait for any of `events`, rejecting on 'error' or after 10s: corrupt files must not hang import. */
function waitForEvent(target: EventTarget, events: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = 0
    const cleanup = () => {
      window.clearTimeout(timer)
      for (const ev of events) target.removeEventListener(ev, onOk)
      target.removeEventListener('error', onFail)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onFail = () => {
      cleanup()
      reject(new Error(`media error while ${what}`))
    }
    timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`timed out while ${what}`))
    }, WAIT_MS)
    for (const ev of events) target.addEventListener(ev, onOk)
    target.addEventListener('error', onFail)
  })
}

/** Streams report duration=Infinity until forced to seek far past the end (the 1e10 trick). */
async function resolveInfiniteDuration(el: HTMLMediaElement, what: string): Promise<void> {
  el.currentTime = 1e10
  const deadline = Date.now() + WAIT_MS
  while (!Number.isFinite(el.duration)) {
    if (Date.now() > deadline) throw new Error(`timed out while ${what}`)
    await waitForEvent(el, ['durationchange', 'timeupdate', 'seeked'], what)
  }
}

/** 320x180 contain-fit poster with black letterbox → jpeg 0.75. */
function drawThumbnail(source: CanvasImageSource, srcW: number, srcH: number): Promise<Blob | undefined> {
  if (srcW <= 0 || srcH <= 0) return Promise.resolve(undefined)
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(undefined)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)
  const scale = Math.min(THUMB_W / srcW, THUMB_H / srcH)
  const w = srcW * scale
  const h = srcH * scale
  ctx.drawImage(source, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.75))
}

interface AudioIntrospection {
  mozHasAudio?: boolean
  webkitAudioDecodedByteCount?: number
  audioTracks?: { length: number }
}

function detectHasAudio(el: HTMLVideoElement): boolean {
  const v = el as HTMLVideoElement & AudioIntrospection
  if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio
  if (v.audioTracks) return v.audioTracks.length > 0
  if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount > 0) return true
  // Undetectable here (Chromium's decoded-byte counter can be 0 with
  // preload=metadata even when audio exists): honest default TRUE;
  // refined when WebCodecs demux lands in Phase 3.
  return true
}

/** Detach the element from its blob so the URL can be revoked without leaks. */
function releaseMedia(el: HTMLMediaElement, url: string): void {
  el.removeAttribute('src')
  el.load()
  URL.revokeObjectURL(url)
}

async function probeVideo(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  try {
    video.src = url
    await waitForEvent(video, ['loadedmetadata'], `reading metadata of ${file.name}`)
    if (!Number.isFinite(video.duration)) {
      await resolveInfiniteDuration(video, `resolving duration of ${file.name}`)
    }
    const durationS = Number.isFinite(video.duration) ? video.duration : 0

    let thumbnailBlob: Blob | undefined
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      video.currentTime = Math.min(0.5, durationS * 0.1)
      await waitForEvent(video, ['seeked'], `seeking poster frame of ${file.name}`)
      thumbnailBlob = await drawThumbnail(video, video.videoWidth, video.videoHeight)
    }

    return {
      kind: 'video',
      durationS,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      hasAudio: detectHasAudio(video),
      hasVideo: true,
      thumbnailBlob,
    }
  } finally {
    releaseMedia(video, url)
  }
}

async function probeAudio(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file)
  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  try {
    audio.src = url
    await waitForEvent(audio, ['loadedmetadata'], `reading metadata of ${file.name}`)
    if (!Number.isFinite(audio.duration)) {
      await resolveInfiniteDuration(audio, `resolving duration of ${file.name}`)
    }
    return {
      kind: 'audio',
      durationS: Number.isFinite(audio.duration) ? audio.duration : 0,
      hasAudio: true,
      hasVideo: false,
    }
  } finally {
    releaseMedia(audio, url)
  }
}

async function probeImage(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file)
  const img = new Image()
  try {
    img.src = url
    await waitForEvent(img, ['load'], `decoding image ${file.name}`)
    return {
      kind: 'image',
      durationS: 0,
      width: img.naturalWidth || undefined,
      height: img.naturalHeight || undefined,
      hasAudio: false,
      hasVideo: false,
      thumbnailBlob: await drawThumbnail(img, img.naturalWidth, img.naturalHeight),
    }
  } finally {
    img.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}

export async function probeFile(file: File): Promise<ProbeResult> {
  if (file.type.startsWith('video/')) return probeVideo(file)
  if (file.type.startsWith('audio/')) return probeAudio(file)
  if (file.type.startsWith('image/')) return probeImage(file)
  throw new Error('unsupported')
}
