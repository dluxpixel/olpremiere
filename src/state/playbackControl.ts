// Wires the engine Transport (audio-master clock) to the store. The single
// place Space / J / K / L and the transport buttons act through.

import { scheduleAudio } from '../engine/audio'
import { Transport } from '../engine/playback'
import { pauseAllPreviewVideos } from '../engine/preview'
import { activeSequence } from '../engine/types'
import { useStore } from './store'

const transport = new Transport({
  getEndS: () => activeSequence(useStore.getState().project).durationS,
  onTick: (t) => useStore.getState().setUI({ playheadS: Math.max(0, t) }),
  onStateChange: (playing) => {
    useStore.getState().setUI({ playing })
    if (!playing) pauseAllPreviewVideos()
  },
  schedule: (fromS) => {
    const { project } = useStore.getState()
    return scheduleAudio(activeSequence(project), project.assets, fromS)
  },
})

export function togglePlay(): void {
  if (transport.playing) {
    transport.pause()
    return
  }
  const s = useStore.getState()
  const endS = activeSequence(s.project).durationS
  if (endS <= 0) return
  // At the end, Space restarts from the top (Premiere behavior).
  const fromS = s.ui.playheadS >= endS - 1e-6 ? 0 : s.ui.playheadS
  void transport.play(fromS, 1)
}

export function pausePlayback(): void {
  if (transport.playing) transport.pause()
}

const SHUTTLE_RATES = [1, 2, 4]

/** J (dir -1) / L (dir +1): repeat presses in the same direction speed up. */
export function shuttle(dir: -1 | 1): void {
  const s = useStore.getState()
  const endS = activeSequence(s.project).durationS
  if (endS <= 0) return
  let magnitude = 1
  if (transport.playing && Math.sign(transport.rate) === dir) {
    const idx = SHUTTLE_RATES.indexOf(Math.abs(transport.rate))
    magnitude = SHUTTLE_RATES[Math.min(idx + 1, SHUTTLE_RATES.length - 1)] ?? 1
  }
  const fromS = transport.playing ? transport.currentTime() : s.ui.playheadS
  void transport.play(fromS, dir * magnitude)
}

export const isPlaying = (): boolean => transport.playing
