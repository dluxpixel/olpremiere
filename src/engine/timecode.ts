// Time formatting + frame math shared by the transport, ruler, and inspector.
// Integer fps only for now (24/25/30/60); drop-frame timecode is out of scope.

const pad = (n: number): string => String(n).padStart(2, '0')

/** Seconds → "HH:MM:SS:FF". Negative times clamp to zero. */
export function formatTimecode(tS: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps))
  const totalFrames = Math.max(0, Math.round(tS * fpsInt))
  const ff = totalFrames % fpsInt
  const totalSeconds = Math.floor(totalFrames / fpsInt)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}

/** "HH:MM:SS:FF" (or "MM:SS:FF", "SS:FF", plain seconds) → seconds, or null. */
export function parseTimecode(text: string, fps: number): number | null {
  const fpsInt = Math.max(1, Math.round(fps))
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':').map((p) => p.trim())
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return null
  const nums = parts.map(Number)
  const ff = nums[nums.length - 1]
  const ss = nums[nums.length - 2] ?? 0
  const mm = nums[nums.length - 3] ?? 0
  const hh = nums[nums.length - 4] ?? 0
  return hh * 3600 + mm * 60 + ss + ff / fpsInt
}

export const timeToFrame = (tS: number, fps: number): number => Math.round(tS * fps)
export const frameToTime = (frame: number, fps: number): number => frame / fps
/** Quantize a time to the sequence frame grid. */
export const quantizeToFrame = (tS: number, fps: number): number => Math.round(tS * fps) / fps
