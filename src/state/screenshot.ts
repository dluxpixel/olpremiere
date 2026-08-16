// Photograph the frame he is looking at and put it in his media.
//
// His ask, 2026-08-15: a button by the blur and the aspect picker that "takes a
// perfect screenshot and adds it to the media". Perfect is the load-bearing
// word, and it is why this does not read back the monitor canvas: see the note
// at the top of engine/grabFrame.ts.

import { grabFrame } from '../engine/grabFrame'
import { formatTimecode } from '../engine/timecode'
import { activeSequence } from '../engine/types'
import { importFiles } from './mediaActions'
import { pausePlayback } from './playbackControl'
import { useStore } from './store'
import { useToasts } from './toasts'

/**
 * The still's name: "Frame 00-00-12-05.png".
 *
 * Timecode colons are illegal in a Windows filename and would come back as an
 * unsaveable asset the moment he exported or dragged one out, so they are
 * dashes. The order still reads as hours, minutes, seconds, frames.
 */
export function screenshotName(tS: number, fps: number): string {
  return `Frame ${formatTimecode(tS, fps).replaceAll(':', '-')}.png`
}

// A second click while the first grab is waiting on a decode would render into
// the same canvas underneath it and both would read back the later frame.
let grabbing = false

/**
 * Take a still of the current frame at full sequence size and import it.
 *
 * Resolves when the still is in the bin, or as soon as there was nothing to
 * photograph. Never throws at the caller: every failure is a toast.
 */
export async function screenshotToMedia(): Promise<void> {
  if (grabbing) return
  const show = useToasts.getState().show
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  if (seq.durationS <= 0) {
    show('Nothing on the timeline to photograph yet', 'info')
    return
  }
  // A moving picture is not the frame he means. Pausing first also settles the
  // renderer's playback bookkeeping before the grab draws its own frames.
  pausePlayback()
  // The RAW playhead, the same number the monitor draws at.
  const tS = useStore.getState().ui.playheadS

  grabbing = true
  try {
    const grab = await grabFrame(seq, s.project.assets, tS)
    if (!grab) {
      show('Could not take the screenshot', 'danger')
      return
    }
    const file = new File([grab.blob], screenshotName(tS, seq.fps), { type: 'image/png' })
    await importFiles([file], {
      successMessage: `Screenshot added to your media, ${grab.width} by ${grab.height}`,
    })
    // Said AFTER the import, and said plainly: the picture is real, one layer of
    // it just never finished loading in time. Silence here would let him build on
    // a still that is quietly missing a clip.
    if (!grab.complete) {
      show('Some footage was still loading, so the screenshot may be missing a layer', 'info')
    }
  } finally {
    grabbing = false
  }
}
