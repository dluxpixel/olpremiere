// "Auto-Caption from voiceover": local Whisper on an audio clip → word-by-word
// caption clips. The tiny status store drives the progress pill; only one
// transcription runs at a time (the model is heavyweight).

import { create } from 'zustand'
import {
  TRANSCRIBE_SAMPLE_RATE,
  extractClipPcm,
  tidyTranscribedWords,
  timelineWords,
  transcribePcm,
  wordsFromAsrChunks,
} from '../engine/captions/transcribe'
import { markEmphasis, speechEnvelope } from '../engine/captions/emphasis'
import { dropWordsWithoutVoice, voiceTrackForClip } from '../engine/captions/voiceActivity'
import { getCaptionEmphasis, getCaptionLanguage } from '../engine/captions/transcribeConfig'
import { clipEmitsAudio } from '../engine/audio'
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
 *
 * ONE analysis pass per clip, and it is started HERE, in the same tick as the
 * Whisper worker rather than before or after it. Reading RNNoise's voice
 * probabilities costs a measured 77 ms per second of audio in chromium (4.6 s
 * for a 60 s clip), which would be a plainly noticeable wait if it were queued
 * ahead of the model. Run alongside, it finishes inside an inference that takes
 * longer, so his wait does not move.
 */
async function wordsForClip(clip: Clip, asset: MediaAsset): Promise<CaptionWord[]> {
  useTranscribe.setState({ status: 'reading', pct: null, downloading: false, cancel: null })
  const pcm = await extractClipPcm(asset, clip)
  // The loudness envelope for the keyword highlight, taken HERE and nowhere
  // else, because transcribePcm below TRANSFERS this buffer to its worker and
  // leaves the array detached with a length of zero. One pass over the samples
  // and it keeps 50 floats per second instead of the audio, so the whole clip's
  // loudness costs about 3 kB of the memory the PCM was already using.
  //
  // MEASURED COST on this machine, and it is not something he can feel: 0.9 ms
  // for a 60 s clip, 4.4 ms for 300 s, envelope and pick together, against a
  // Whisper run of tens of seconds for the same audio. It is also spent while
  // the model is still loading, so it does not extend the wait at all.
  const envelope = getCaptionEmphasis() ? speechEnvelope(pcm, TRANSCRIBE_SAMPLE_RATE) : null
  // The persisted language pick (CaptionsDialog) drives every caption door.
  const run = transcribePcm(pcm, getCaptionLanguage(), (p) =>
    useTranscribe.setState({ status: p.phase, pct: p.pct, downloading: p.downloading ?? false }),
  )
  // Aborted the moment the run fails or is cancelled, so a dead run cannot leave
  // an analysis churning into the next clip of a whole-timeline sweep.
  const stop = new AbortController()
  const voice = voiceTrackForClip(asset, clip, stop.signal)
  useTranscribe.setState({ cancel: run.cancel })
  let chunks
  try {
    chunks = await run.promise
  } catch (err) {
    stop.abort()
    throw err
  }
  // tidy BEFORE the timeline mapping: loops, bare punctuation and Whisper's
  // end-of-silence inventions are recogniser artifacts, not edits.
  const heard = tidyTranscribedWords(wordsFromAsrChunks(chunks))
  // Then drop what the audio says nobody said. A null track means the detector
  // had no opinion (wasm blocked, undecodable audio), and no opinion keeps every
  // word: this filter may only ever take words away, never rescue a caption run.
  const track = await voice
  const kept = track ? dropWordsWithoutVoice(heard, track) : heard
  // Then the keyword highlight, LAST, in clip time, where these words and that
  // envelope share one clock. After the voice filter on purpose: a word the
  // audio says nobody said must not be able to win the colour.
  return timelineWords(envelope ? markEmphasis(kept, envelope) : kept, clip)
}

/**
 * Every clip that actually makes sound and should be captioned, or just the
 * ones whose ids are given.
 *
 * The id filter exists so captioning a SELECTION reuses the whole-timeline path
 * instead of running the single-clip one N times: the words are pooled and laid
 * down in ONE pass, so a selection of eight clips still produces one caption
 * track and one undo step.
 *
 * Two kinds of track are passed over:
 *  - LOCKED, because captioning them is work he cannot undo by hand afterwards.
 *  - MUSIC. A track he has marked `audioRole: 'music'` (right-click the track
 *    header) is a backing bed, so every word Whisper finds in it is a mishearing
 *    of a melody. Sending it to the recogniser was the reported bug: "Caption
 *    every clip" transcribed the song. 'voice' and UNMARKED tracks are untouched,
 *    because unmarked is the default and skipping it would silently swallow the
 *    voiceover of anyone who never opened that menu.
 */
function audibleClips(onlyIds?: ReadonlySet<string>): {
  targets: { clip: Clip; asset: MediaAsset }[]
  /** Sounding clips passed over only because their track is marked as music. */
  skippedMusic: number
} {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // clipEmitsAudio, not the asset alone. A linked video clip and its audio
  // partner share one assetId and both report hasAudio, so filtering on the
  // asset transcribed the same take TWICE and laid both word sets at the same
  // timeline moment: every caption came out doubled, and the Whisper wait
  // doubled with it. Worse the more clips there are. This is the predicate the
  // mixer and both export paths already use to stop linked A/V doubling sound.
  const sounding = (t: (typeof seq.tracks)[number]): { clip: Clip; asset: MediaAsset }[] =>
    t.clips
      .filter((c) => clipEmitsAudio(t, c) && (!onlyIds || onlyIds.has(c.id)))
      .map((clip) => ({ clip, asset: s.project.assets[clip.assetId] }))
      .filter((x): x is { clip: Clip; asset: MediaAsset } => !!x.asset?.hasAudio)

  const unlocked = seq.tracks.filter((t) => !t.locked)
  return {
    targets: unlocked
      .filter((t) => t.audioRole !== 'music')
      .flatMap(sounding)
      .sort((a, b) => a.clip.startS - b.clip.startS),
    skippedMusic: unlocked.filter((t) => t.audioRole === 'music').flatMap(sounding).length,
  }
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
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset?.hasAudio) {
    toasts.show('Select an audio clip with sound to caption', 'danger')
    return
  }
  // The sweep doors skip a music track outright. This door does NOT, because one
  // clip is him pointing at one thing on purpose and refusing would be the app
  // arguing with him. It says out loud what it is doing instead, so the two
  // rules never look like the same rule quietly disagreeing.
  if (track?.audioRole === 'music') {
    toasts.show('Captioning a clip on your music track, because you picked it')
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
export async function autoCaptionEveryClip(
  preset?: TextStylePreset,
  /** When given, caption only these clips. Used by the right-click on a selection. */
  onlyIds?: ReadonlySet<string>,
): Promise<void> {
  const toasts = useToasts.getState()
  if (useTranscribe.getState().status !== 'idle') {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  const { targets, skippedMusic } = audibleClips(onlyIds)
  if (targets.length === 0) {
    // Naming the music track matters here: without it "no clips with sound"
    // reads as a bug on a timeline he can plainly hear.
    toasts.show(
      skippedMusic > 0
        ? 'Nothing to caption, the clips with sound are on a music track'
        : onlyIds
          ? 'None of those clips have sound'
          : 'No clips with sound to caption',
      'danger',
    )
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
    label: onlyIds ? 'Auto-caption selected clips' : 'Auto-caption every clip',
    preset: preset ?? rememberedCaptionPreset(),
  })
  if (cancelled) toasts.show('Stopped early, captioned what was heard so far')
  else if (failed > 0) toasts.show(`${failed} clip${failed === 1 ? '' : 's'} could not be read`, 'danger')
}
