// "Auto-Caption from voiceover": local Whisper on an audio clip → word-by-word
// caption clips. The tiny status store drives the progress pill; only one
// transcription runs at a time (the model is heavyweight).

import { create } from 'zustand'
import {
  extractClipPcm,
  tidyTranscribedWords,
  timelineWords,
  transcribePcm,
  wordsFromAsrChunks,
} from '../engine/captions/transcribe'
import { getCaptionLanguage } from '../engine/captions/transcribeConfig'
import { activeSequence, type Clip, type MediaAsset } from '../engine/types'
import type { CaptionWord } from '../engine/captions/captions'
import { addCaptionsFromWords } from './captionActions'
import { rememberedCaptionPreset } from './textPresets'
import { useStore } from './store'
import type { TextStylePreset } from './textPresets'
import { useToasts } from './toasts'

export type TranscribeStatus = 'idle' | 'reading' | 'model' | 'listening'

interface TranscribeState {
  status: TranscribeStatus
  /** Model progress percentage (0-100) when known, else null. */
  pct: number | null
  /** True only when files are really coming off the network, not out of the cache. */
  downloading: boolean
  cancel: (() => void) | null
  /** Which clip of how many, when captioning the whole timeline. Null for a single clip. */
  queue: { index: number; total: number } | null
}

export const useTranscribe = create<TranscribeState>(() => ({
  status: 'idle',
  pct: null,
  downloading: false,
  cancel: null,
  queue: null,
}))

const reset = (): void =>
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })

/** True when the caller asked to stop, rather than something going wrong. */
const isCancel = (err: unknown): boolean => typeof err === 'object' && err !== null && 'cancelled' in err

/**
 * Transcribe ONE clip and return its words already mapped onto the timeline.
 * Shared by the single-clip door and the whole-timeline run so the two can never
 * disagree about tidying, language, or how clip time maps to timeline time.
 */
async function wordsForClip(clip: Clip, asset: MediaAsset): Promise<CaptionWord[]> {
  useTranscribe.setState({ status: 'reading', pct: null, downloading: false, cancel: null })
  const pcm = await extractClipPcm(asset, clip)
  // The persisted language pick (CaptionsDialog) drives every caption door.
  const run = transcribePcm(pcm, getCaptionLanguage(), (p) =>
    useTranscribe.setState({ status: p.phase, pct: p.pct, downloading: p.downloading ?? false }),
  )
  useTranscribe.setState({ cancel: run.cancel })
  const chunks = await run.promise
  // tidy BEFORE the timeline mapping: loops, bare punctuation and Whisper's
  // end-of-silence inventions are recogniser artifacts, not edits.
  return timelineWords(tidyTranscribedWords(wordsFromAsrChunks(chunks)), clip)
}

/**
 * Every clip on the timeline that actually has sound, in the order it plays.
 * Locked tracks are skipped, because captioning them is work he cannot undo by
 * hand afterwards.
 */
function audibleClips(): { clip: Clip; asset: MediaAsset }[] {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  return seq.tracks
    .filter((t) => !t.locked)
    .flatMap((t) => t.clips)
    .map((clip) => ({ clip, asset: s.project.assets[clip.assetId] }))
    .filter((x): x is { clip: Clip; asset: MediaAsset } => !!x.asset?.hasAudio)
    .sort((a, b) => a.clip.startS - b.clip.startS)
}

/** Transcribe the audio clip locally and lay its words down as captions. */
export async function autoCaptionFromClip(clipId: string, preset?: TextStylePreset): Promise<void> {
  const toasts = useToasts.getState()
  if (useTranscribe.getState().status !== 'idle') {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset?.hasAudio) {
    toasts.show('Select an audio clip with sound to caption', 'danger')
    return
  }

  try {
    const words = await wordsForClip(clip, asset)
    if (words.length === 0) {
      toasts.show('No speech found in the clip', 'danger')
    } else {
      // No preset passed (the right-click door) falls back to the REMEMBERED
      // style, so both doors produce the same captions.
      addCaptionsFromWords(words, {
        label: 'Auto-caption from voiceover',
        preset: preset ?? rememberedCaptionPreset(),
      })
    }
  } catch (err) {
    if (!isCancel(err)) {
      toasts.show('Transcription failed, the model downloads once and needs a connection', 'danger')
      console.error('auto-caption:', err)
    }
  } finally {
    reset()
  }
}

/**
 * Caption EVERY clip on the timeline in one action.
 *
 * His ask, 2026-07-28: "I want it so that I can select an option that adds
 * captions for every single clip." Before this, captioning a twelve-clip edit
 * meant right-clicking twelve times and getting twelve separate caption tracks
 * stacked on top of each other.
 *
 * The clips are transcribed one at a time (the Whisper model is far too heavy to
 * run several at once), but the words are pooled and laid down in a SINGLE pass
 * at the end. That is what makes it one caption track and one undo step. Cancel
 * stops the whole run, and whatever was already heard is still laid down rather
 * than thrown away.
 */
export async function autoCaptionEveryClip(preset?: TextStylePreset): Promise<void> {
  const toasts = useToasts.getState()
  if (useTranscribe.getState().status !== 'idle') {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  const targets = audibleClips()
  if (targets.length === 0) {
    toasts.show('No clips with sound to caption', 'danger')
    return
  }

  const words: CaptionWord[] = []
  let cancelled = false
  let failed = 0
  try {
    for (let i = 0; i < targets.length; i++) {
      const { clip, asset } = targets[i]
      useTranscribe.setState({ queue: { index: i + 1, total: targets.length } })
      try {
        words.push(...(await wordsForClip(clip, asset)))
      } catch (err) {
        if (isCancel(err)) {
          cancelled = true
          break
        }
        // One unreadable clip must not throw away the whole run: count it, say so
        // at the end, and keep going through the rest.
        failed++
        console.error('caption every clip:', err)
      }
    }
  } finally {
    reset()
  }

  if (words.length === 0) {
    toasts.show(cancelled ? 'Stopped before anything was heard' : 'No speech found in any clip', 'danger')
    return
  }
  addCaptionsFromWords(words, {
    label: 'Auto-caption every clip',
    preset: preset ?? rememberedCaptionPreset(),
  })
  if (cancelled) toasts.show('Stopped early, captioned what was heard so far')
  else if (failed > 0) toasts.show(`${failed} clip${failed === 1 ? '' : 's'} could not be read`, 'danger')
}
