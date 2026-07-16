// Audio helpers that need the decoded buffer. Normalize = peak-normalize a
// clip's gain to a target ceiling (Premiere/Vegas staple), so a quiet voiceover
// jumps up to a usable level with one click.

import { getAudioBuffer } from '../engine/audio'
import { activeSequence } from '../engine/types'
import { setClipGainDb } from './clipEdits'
import { useStore } from './store'
import { useToasts } from './toasts'

/** ~ -1 dBFS ceiling — loud but leaves headroom so the export doesn't clip. */
const TARGET_PEAK = 0.891

/** Set a clip's gain so its loudest sample hits the target ceiling. */
export async function normalizeClipGain(clipId: string): Promise<void> {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset?.hasAudio) {
    useToasts.getState().show('Pick an audio clip with sound', 'danger')
    return
  }
  if (track?.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return
  }
  const buffer = await getAudioBuffer(asset)
  if (!buffer) {
    useToasts.getState().show('Could not decode the audio', 'danger')
    return
  }
  const sr = buffer.sampleRate
  const s0 = Math.max(0, Math.floor(clip.inS * sr))
  const s1 = Math.min(buffer.length, Math.ceil(clip.outS * sr))
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = s0; i < s1; i++) {
      const a = Math.abs(data[i])
      if (a > peak) peak = a
    }
  }
  if (peak <= 1e-4) {
    useToasts.getState().show('That clip is silent', 'danger')
    return
  }
  const db = Math.max(-60, Math.min(12, 20 * Math.log10(TARGET_PEAK / peak)))
  setClipGainDb(clipId, Math.round(db * 10) / 10)
  useToasts.getState().show(`Normalized (${db > 0 ? '+' : ''}${db.toFixed(1)} dB)`)
}
