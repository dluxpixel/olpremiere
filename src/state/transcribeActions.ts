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
import { activeSequence } from '../engine/types'
import { addCaptionsFromWords } from './captionActions'
import { rememberedCaptionPreset } from './textPresets'
import { useStore } from './store'
import type { TextStylePreset } from './textPresets'
import { useToasts } from './toasts'

export type TranscribeStatus = 'idle' | 'reading' | 'model' | 'listening'

interface TranscribeState {
  status: TranscribeStatus
  /** Model download percentage (0-100) when known, else null. */
  pct: number | null
  cancel: (() => void) | null
}

export const useTranscribe = create<TranscribeState>(() => ({
  status: 'idle',
  pct: null,
  cancel: null,
}))

const reset = (): void => useTranscribe.setState({ status: 'idle', pct: null, cancel: null })

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

  useTranscribe.setState({ status: 'reading', pct: null, cancel: null })
  try {
    const pcm = await extractClipPcm(asset, clip)
    // The persisted language pick (CaptionsDialog) also drives this right-click
    // path — one setting, every caption entrance.
    const run = transcribePcm(pcm, getCaptionLanguage(), (p) =>
      useTranscribe.setState({ status: p.phase, pct: p.pct }),
    )
    useTranscribe.setState({ cancel: run.cancel })
    const chunks = await run.promise
    // tidy BEFORE the timeline mapping: loops, bare punctuation and Whisper's
    // end-of-silence inventions are recogniser artifacts, not edits.
    const words = timelineWords(tidyTranscribedWords(wordsFromAsrChunks(chunks)), clip)
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
    if (!(typeof err === 'object' && err !== null && 'cancelled' in err)) {
      toasts.show(
        'Transcription failed, the model downloads once and needs a connection',
        'danger',
      )
      console.error('auto-caption:', err)
    }
  } finally {
    reset()
  }
}
