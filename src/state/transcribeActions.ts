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
 * What to tell him when a caption run throws, in the words of the thing that
 * actually broke.
 *
 * Everything used to come out as "the model downloads once and needs a
 * connection", which is true of exactly one of these and sends him to his router
 * for the other three. Fifth-grade words, no error codes: the raw message is for
 * the console, this is for him.
 */
function captionFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (/decodable audio|no audio|leaves no audio/i.test(raw)) {
    return 'That clip has no sound the app can read, so there is nothing to caption'
  }
  if (/stopped responding|watchdog/i.test(raw)) {
    return 'The speech model stopped responding, so nothing was captioned. Try that clip again'
  }
  if (/already running/i.test(raw)) return 'A transcription is already running'
  return 'Captions failed. The speech model downloads once and needs a connection the first time'
}

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
export async function wordsForClip(clip: Clip, asset: MediaAsset): Promise<CaptionWord[]> {
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
 * ⛔ "MAKES SOUND" IS THE MIXER'S RULE, NOT A SECOND OPINION, and it used not to
 * be. `engine/audio.ts` decides audibility with `anySolo ? t.solo : !t.muted`
 * plus `clip.enabled`, and none of that was mirrored here, so a MUTED track was
 * transcribed and captioned.
 *
 * That is not a corner case, it is how a voiceover gets recorded: keep take 1
 * muted on A1, record take 2 on A2. Captioning both pooled the two takes into
 * ONE word list and sorted it by time, so the same sentence arrived twice
 * interleaved, and the non-overlap clamp in `chunkWords` then pushed every later
 * caption further right for the whole timeline. Doubled text at the top, seconds
 * of drift by the end, and double the wait to produce it.
 *
 * Three kinds of clip are passed over, and every one of them is COUNTED so the
 * run can say what it did rather than look broken:
 *  - NOT AUDIBLE. Muted, or unsoloed while something else is soloed, or a clip
 *    switched off. If he cannot hear it, it is not in his video.
 *  - MUSIC. A track he has marked `audioRole: 'music'` (right-click the track
 *    header) is a backing bed, so every word Whisper finds in it is a mishearing
 *    of a melody. Sending it to the recogniser was the reported bug: "Caption
 *    every clip" transcribed the song. 'voice' and UNMARKED tracks are untouched,
 *    because unmarked is the default and skipping it would silently swallow the
 *    voiceover of anyone who never opened that menu.
 *  - LOCKED. ⚠️ The old reason given here, "work he cannot undo by hand
 *    afterwards", does not survive reading: captions land on a BRAND NEW track
 *    and the locked one is never touched. The skip stays anyway, because a lock
 *    is him saying leave this alone and the app should not argue. What changes
 *    is that it is no longer SILENT: locking a finished voiceover used to make
 *    the whole dialog say "Add a clip with sound first" on a timeline he could
 *    plainly hear.
 */
export function audibleClips(onlyIds?: ReadonlySet<string>): {
  targets: { clip: Clip; asset: MediaAsset }[]
  /** Sounding clips passed over only because their track is marked as music. */
  skippedMusic: number
  /** Sounding clips passed over only because their track is locked. */
  skippedLocked: number
  /** Clips passed over because he cannot hear them: muted, unsoloed, or switched off. */
  skippedSilent: number
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

  // The mixer's own rule, verbatim: solo wins, otherwise every unmuted track.
  const anySolo = seq.tracks.some((t) => t.solo)
  const heard = (t: (typeof seq.tracks)[number]): boolean => (anySolo ? t.solo : !t.muted)
  // And a clip he has switched off is not in his video either.
  const playing = (x: { clip: Clip }): boolean => x.clip.enabled

  const audible = seq.tracks.filter((t) => heard(t) && !t.locked)
  const all = seq.tracks.flatMap(sounding)
  const targets = audible
    .filter((t) => t.audioRole !== 'music')
    .flatMap(sounding)
    .filter(playing)
    .sort((a, b) => a.clip.startS - b.clip.startS)

  return {
    targets,
    skippedMusic: audible.filter((t) => t.audioRole === 'music').flatMap(sounding).filter(playing).length,
    skippedLocked: seq.tracks.filter((t) => t.locked && heard(t)).flatMap(sounding).filter(playing).length,
    // Whatever is left over: muted, unsoloed, or switched off. Counted by
    // difference so a fourth reason added later cannot go unreported.
    skippedSilent:
      all.length -
      targets.length -
      audible.filter((t) => t.audioRole === 'music').flatMap(sounding).filter(playing).length -
      seq.tracks.filter((t) => t.locked && heard(t)).flatMap(sounding).filter(playing).length,
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
  // ⛔ AND A LOCKED TRACK GOES THE SAME WAY, which it did not until now.
  //
  // The sweep refuses a locked track out loud, this door had no lock check at
  // all, and neither said anything: right-click ONE clip on a locked track and it
  // captioned silently, right-click TWO and the identical menu item refused. One
  // label, two rules, decided by how many clips he happened to have selected.
  //
  // Settled the way the music case above was settled, and for the same reason:
  // **a lock says do not CHANGE this track, and reading its sound changes
  // nothing.** The captions are written as their own clips elsewhere, so the
  // locked track is untouched either way, and refusing would be the app arguing
  // with a clip he pointed at on purpose. It says so, so the two doors read as
  // one rule with a stated exception rather than as a bug.
  if (track?.locked) {
    toasts.show('Captioning a clip on a locked track, because you picked it. The track itself is untouched')
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
      // ⛔ SAY WHICH FAILURE IT WAS. Every non-cancel throw used to be reported
      // as a network problem, so an audio file that would not decode, or a clip
      // trimmed down to nothing, sent him off to check his internet. The throws
      // that reach here include "clip has no decodable audio", "clip trim leaves
      // no audio" and the model watchdog, and only one of them is about a
      // connection.
      toasts.show(captionFailureMessage(err), 'danger')
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
  const { targets, skippedMusic, skippedLocked, skippedSilent } = audibleClips(onlyIds)
  if (targets.length === 0) {
    // ⛔ NAME THE REASON. Without it "no clips with sound" reads as a bug on a
    // timeline he can plainly hear, and he goes looking in the wrong place. A
    // locked voiceover track used to produce exactly that.
    toasts.show(
      skippedLocked > 0
        ? 'Nothing to caption, the track with the sound on it is locked'
        : skippedMusic > 0
          ? 'Nothing to caption, the clips with sound are on a music track'
          : skippedSilent > 0
            ? 'Nothing to caption, the clips with sound are muted or switched off'
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
  let vanished = 0
  try {
    for (let i = 0; i < targets.length; i++) {
      const { clip: listed, asset } = targets[i]
      // ⛔ THE CLIP IS READ AGAIN HERE, NOT TAKEN FROM THE LIST, and this is a real
      // defect rather than tidiness.
      //
      // The list is built before the loop and his 44 clip sweep takes the better
      // part of a minute, with nothing blocking the timeline while it runs. Words
      // are placed with the clip's `startS`, so a ripple delete anywhere ahead of
      // the run shifted every clip it had not reached yet and their captions
      // landed at the timecode the clip used to sit at. Delete a clip outright and
      // it was still transcribed, and captions appeared for footage that is gone.
      //
      // Reading it fresh costs one lookup per clip against a minute of inference,
      // and it closes both: a moved clip is captioned where it is NOW, and a clip
      // that no longer exists is skipped and counted.
      const live = activeSequence(useStore.getState().project)
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === listed.id)
      if (!live) {
        vanished++
        continue
      }
      useTranscribe.setState({ queue: { index: i + 1, total: targets.length } })
      try {
        words.push(...(await wordsForClip(live, asset)))
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
  // Deleting a clip while the run is working through the timeline is a perfectly
  // reasonable thing to do, and silently captioning one fewer clip than the
  // counter promised is not. Said plainly, and not as a failure, because nothing
  // failed.
  else if (vanished > 0) {
    toasts.show(`${vanished} clip${vanished === 1 ? '' : 's'} left the timeline while this ran, so ${vanished === 1 ? 'it was' : 'they were'} skipped`)
  }
}
