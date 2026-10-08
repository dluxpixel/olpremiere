// "Auto-Caption from voiceover": local Whisper on an audio clip → word-by-word
// caption clips. The tiny status store drives the progress pill; only one
// transcription runs at a time (the model is heavyweight).

import { create } from 'zustand'
import {
  TRANSCRIBE_SAMPLE_RATE,
  type AsrChunk,
  extractClipPcm,
  tidyTranscribedWords,
  timelineWords,
  transcribePcm,
  wordsFromAsrChunks,
} from '../engine/captions/transcribe'
import { markEmphasis, speechEnvelope } from '../engine/captions/emphasis'
import { dropWordsWithoutVoice, trimWordsToVoice, voiceTrackForClip } from '../engine/captions/voiceActivity'
import { dropWordsInMusic, isPureMusic, type SpeechTrack } from '../engine/captions/musicGate'
import { musicTrackForClip } from '../engine/captions/musicAnalysis'
import { applyRewrites, type Vocabulary } from '../engine/captions/vocabulary'
import {
  getCaptionEmphasis,
  getCaptionLanguage,
  modelFor,
  whisperModel,
  type CaptionLanguage,
} from '../engine/captions/transcribeConfig'
import { DIP_ENVELOPE_HOP_S, correctWordLag, meetAtDips, snapOnsetsToVoice } from '../engine/captions/wordTiming'
import { clipEmitsAudio } from '../engine/audio'
import { clipEndS } from '../engine/timeline'
import { activeSequence, type Clip, type MediaAsset, type SpokenWord } from '../engine/types'
import type { CaptionWord } from '../engine/captions/captions'
import type { CaptionStyle } from '../engine/captions/captionStyle'
import { keepHitTakes, scriptHeard } from '../engine/captions/scriptAlign'
import { plural } from '../engine/plural'
import { addCaptionsFromWords } from './captionActions'
import { defaultCaptionStyle } from './captionStyles'
import { currentVocabulary } from './captionVocabulary'
import { useStore } from './store'
import { useToasts } from './toasts'

export type TranscribeStatus = 'idle' | 'reading' | 'screening' | 'model' | 'listening'

interface TranscribeState {
  status: TranscribeStatus
  /** Model progress percentage (0-100) when known, else null. */
  pct: number | null
  /** True only when files are really coming off the network, not out of the cache. */
  downloading: boolean
  cancel: (() => void) | null
  /** Which clip of how many, when captioning the whole timeline. Null for a single clip. */
  queue: { index: number; total: number } | null
  /** The clip being heard right now, so only its row in the Words tab says "Listening". */
  clipId: string | null
}

export const useTranscribe = create<TranscribeState>(() => ({
  status: 'idle',
  pct: null,
  downloading: false,
  cancel: null,
  queue: null,
  clipId: null,
}))

const reset = (): void =>
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null, clipId: null })

/** True when the caller asked to stop, rather than something going wrong. */
export const isCancel = (err: unknown): boolean => typeof err === 'object' && err !== null && 'cancelled' in err

/**
 * The caption job running now, and its one Stop.
 *
 * ⛔ ONE STOP FOR THE WHOLE JOB, SHOWN THE WHOLE TIME IT WORKS (CA-14). The
 * Stop used to be whatever the step in flight had handed over: nothing while a
 * clip's sound was read, so the button vanished; the finished screening's
 * abort after that, so a press did nothing; and the recogniser's own cancel
 * once it had answered, which by then does nothing either, so a sweep carried
 * on to the next clip while the voice and music checks finished. Now the job
 * owns the Stop. A press marks the job and ends whatever step is in flight, and
 * every wait in wordsForClip and every clip of a sweep checks the mark.
 *
 * ⛔ AND IT IS CLAIMED BEFORE THE FIRST WAIT (CA-10). Every door read his
 * vocabulary (every saved project) after its "already running" check and
 * before any status was set, so for that whole read the pill was hidden and
 * every caption button was live, and a second click started a second run.
 */
export interface CaptionJob {
  stopped: boolean
  /** How to end the step in flight: the screening, the recogniser, the analyses. */
  readonly ends: Set<() => void>
  /** The model came off the network during this job, so a failure may be the connection. */
  downloaded: boolean
}

/** Claim the one job, or null when one is running. No wait between the check and the claim. */
function claimJob(queue: TranscribeState['queue'] = null): CaptionJob | null {
  if (useTranscribe.getState().status !== 'idle') return null
  const job: CaptionJob = { stopped: false, ends: new Set(), downloaded: false }
  const stop = (): void => {
    if (job.stopped) return
    job.stopped = true
    for (const end of [...job.ends]) end()
  }
  useTranscribe.setState({ status: 'reading', pct: null, downloading: false, cancel: stop, queue, clipId: null })
  return job
}

/** Hand the job back: the pill goes and every caption button works again. */
function releaseJob(job: CaptionJob): void {
  job.ends.clear()
  reset()
}

/** Stop pressed: leave the way a cancelled recogniser does, so every door already knows it. */
function stopIfAsked(job: CaptionJob): void {
  if (job.stopped) throw { cancelled: true }
}

/**
 * What to tell him when a caption run throws, in the words of the thing that
 * actually broke.
 *
 * Everything used to come out as "the model downloads once and needs a
 * connection", which is true of exactly one of these and sends him to his router
 * for the other three. Fifth-grade words, no error codes: the raw message is for
 * the console, this is for him.
 *
 * ⛔ AND THE CONNECTION IS NAMED ONLY WHEN A DOWNLOAD WAS SEEN (CA-20). It was
 * the answer to every failure nobody recognised, so with the model long since
 * on his disk he was still sent to check his internet.
 */
export function captionFailureMessage(err: unknown, downloadSeen = false): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (/decodable audio|no audio|leaves no audio/i.test(raw)) {
    return 'That clip has no sound the app can read, so there is nothing to caption'
  }
  if (/stopped responding|watchdog/i.test(raw)) {
    return 'The speech model stopped responding, so nothing was captioned. Try that clip again'
  }
  if (/already running/i.test(raw)) return 'A transcription is already running'
  if (downloadSeen) return 'Captions failed. The speech model downloads once and needs a connection the first time'
  return 'Captions failed. Try again, and if it keeps failing, restart the app'
}

/** Said, as information, when a clip was heard and nobody in it talks. Not a failure. */
export const NOBODY_TALKS = 'Nobody talks in this clip'

/**
 * What the recogniser said for each stretch of media this session, so the same
 * unchanged clip is never sent to Whisper twice.
 *
 * Nothing kept what it heard, so captioning a clip, then listening to it in the
 * Words tab, then captioning it again in another style paid the full model three
 * times for the same answer. The key is the media, the stretch of it heard, and
 * the language and model, which is everything the answer depends on. What
 * comes AFTER the recogniser (his vocabulary, the voice filter, the timing) is
 * run fresh every time, so a lesson learned since still lands.
 */
const heardBefore = new Map<string, AsrChunk[]>()
/** Plenty for a project's worth of clips, and each entry is only words. */
const HEARD_KEEP = 200
const heardKey = (asset: MediaAsset, clip: Clip, language: CaptionLanguage): string =>
  [asset.id, asset.blobKey, clip.inS, clip.outS, language, modelFor(language)].join('|')
/** Forget everything heard: for tests that change what a clip says between runs. */
export function forgetHeard(): void {
  heardBefore.clear()
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
export async function wordsForClip(clip: Clip, asset: MediaAsset, opts: HearOptions = {}): Promise<CaptionWord[]> {
  // ⛔ A CALLER WITH NO JOB OF ITS OWN GETS ONE FOR THIS CLIP, AND IT IS HANDED
  // BACK HOWEVER THE CLIP ENDS. The silence cutter calls straight in here, and
  // this used to set the pill going and never clear it: after "Cut the quiet
  // parts" the pill read "Listening for words…" for good, its Stop did nothing,
  // and every caption door answered "A transcription is already running" until
  // the app was restarted.
  const own = opts.job ? null : claimJob()
  const job = opts.job ?? own
  if (!job) throw new Error('A transcription is already running')
  try {
    return await hearClip(clip, asset, opts, job)
  } finally {
    if (own) releaseJob(own)
  }
}

interface HearOptions {
  screenFirst?: boolean
  /**
   * Pull each word in to where his voice starts and stops (trimWordsToVoice),
   * so a pause the recogniser swallowed splits the captions. CAPTIONS ONLY:
   * the silence cutter and the Words panel cut at these timings, and the
   * silence cutter's air either side of a cut is tuned against the
   * recogniser's own word ends, so they keep the timings they were built on.
   */
  trimToVoice?: boolean
  /**
   * What his corrections taught (vocabulary.ts): a misspelling he fixed the
   * same way twice is replaced. Read once per run by the caller, never once
   * per clip.
   *
   * ⛔ A PROMISE IS WELCOME, AND IS WHAT THE DOORS PASS. Reading it means
   * reading every saved project, and it is only needed once the recogniser has
   * answered, so it is read alongside the audio and the model, like the voice
   * analysis, instead of in front of them where he waited for it (CA-10).
   */
  vocabulary?: Vocabulary | Promise<Vocabulary>
  /**
   * Handed the words as the Words tab keeps them, in SOURCE seconds of the
   * clip that was heard, so a caption run can store them on the media too
   * and the Words tab never has to listen to that clip again.
   */
  onSpoken?: (words: SpokenWord[]) => void
  /** The door's job, whose Stop this clip answers to. Absent: this clip is a job of its own. */
  job?: CaptionJob
}

async function hearClip(clip: Clip, asset: MediaAsset, opts: HearOptions, job: CaptionJob): Promise<CaptionWord[]> {
  useTranscribe.setState({ status: 'reading', pct: null, downloading: false, clipId: clip.id })

  // ⛔ ON A WHOLE-TIMELINE SWEEP, ASK WHO IS TALKING BEFORE LISTENING TO WORDS.
  //
  // His words, 2026-08-19, looking at "Listening for words… clip 4 of 41":
  // *"I think when it says 'listening for words,' it also listens to video
  // clips. It's kinda weird."* He is right, and the waste was real: every clip
  // got a full Whisper run, so forty clips of gameplay with nobody talking cost
  // forty runs of the biggest model in the app, and everything it invented was
  // then thrown away by the song gate at the end anyway.
  //
  // The classifier that already answers "is somebody talking here" is a small
  // fraction of that, so on a sweep it goes FIRST and a clip with nobody talking
  // in it never reaches the recogniser. The outcome is identical: on a clip
  // where `isPureMusic` holds, the gate below would have dropped every word.
  //
  // It stays ALONGSIDE Whisper for a single clip. There is no queue to save
  // there, so putting it in front would only add to a wait he is watching.
  let screened: SpeechTrack | null = null
  if (opts.screenFirst) {
    const screenStop = new AbortController()
    const endScreen = (): void => screenStop.abort()
    job.ends.add(endScreen)
    useTranscribe.setState({ status: 'screening', pct: null, downloading: false })
    try {
      screened = await musicTrackForClip(asset, clip, screenStop.signal)
    } finally {
      job.ends.delete(endScreen)
    }
    stopIfAsked(job)
    // A null track means the detector had no opinion, and no opinion is never an
    // opinion against him: fall through and listen properly.
    if (screened && isPureMusic(screened)) return []
  }

  const pcm = await extractClipPcm(asset, clip)
  // Reading the sound cannot be interrupted, but a Stop pressed during it is
  // answered the moment it is done, before the model is asked anything.
  stopIfAsked(job)
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
  // Finer loudness for where one word meets the next (wordTiming.meetAtDips),
  // taken here for the same reason and at the same cost: one pass, 100 floats
  // per second. Captions and the Words tab only.
  const loudness = opts.trimToVoice || opts.onSpoken ? speechEnvelope(pcm, TRANSCRIBE_SAMPLE_RATE, DIP_ENVELOPE_HOP_S) : null
  // The persisted language pick (CaptionsDialog) drives every caption door.
  const language = getCaptionLanguage()
  const key = heardKey(asset, clip, language)
  const known = heardBefore.get(key)
  const run = known
    ? null
    : transcribePcm(pcm, language, (p) => {
        if (p.downloading) job.downloaded = true
        useTranscribe.setState({ status: p.phase, pct: p.pct, downloading: p.downloading ?? false })
      })
  // Aborted the moment the run fails or is cancelled, so a dead run cannot leave
  // an analysis churning into the next clip of a whole-timeline sweep.
  const stop = new AbortController()
  const voice = voiceTrackForClip(asset, clip, stop.signal)
  // ⛔ STARTED ALONGSIDE WHISPER, NEVER BEFORE IT, for the same reason the voice
  // analysis is: both run while the recogniser is busy, so their cost is hidden
  // inside a wait he is already having rather than added to the end of it. The
  // exception is a sweep, which has already paid for this answer above and must
  // not pay twice.
  const music = screened ? Promise.resolve(screened) : musicTrackForClip(asset, clip, stop.signal)
  if (!run) useTranscribe.setState({ status: 'listening', pct: null })
  // A Stop from here on ends the recogniser and the two analyses together.
  const endListening = (): void => {
    run?.cancel()
    stop.abort()
  }
  job.ends.add(endListening)
  let chunks: AsrChunk[]
  let vocabulary: Vocabulary | undefined
  let track: Awaited<typeof voice>
  let musicTrack: Awaited<typeof music>
  try {
    try {
      chunks = known ?? (await run!.promise)
    } catch (err) {
      stop.abort()
      throw err
    }
    heardBefore.delete(key)
    heardBefore.set(key, chunks)
    if (heardBefore.size > HEARD_KEEP) heardBefore.delete(heardBefore.keys().next().value!)
    // ⛔ THE STOP IS CHECKED AFTER EVERY WAIT FROM HERE ON. The recogniser has
    // answered, so its own cancel does nothing now, and a Stop pressed while the
    // checks below finish used to be swallowed: a sweep went on to the next clip.
    stopIfAsked(job)
    vocabulary = await opts.vocabulary
    stopIfAsked(job)
    track = await voice
    stopIfAsked(job)
    musicTrack = await music
    stopIfAsked(job)
  } finally {
    job.ends.delete(endListening)
  }
  // tidy BEFORE the timeline mapping: loops, bare punctuation and Whisper's
  // end-of-silence inventions are recogniser artifacts, not edits.
  const tidied = tidyTranscribedWords(wordsFromAsrChunks(chunks))
  // His spellings, put back where he has fixed the same misspelling twice.
  // Before the filters below, which only ever remove words, so a rewritten
  // word is judged on its timing exactly as the word it replaced would have been.
  const heard = vocabulary ? applyRewrites(tidied, vocabulary) : tidied
  // Then drop what the audio says nobody said. A null track means the detector
  // had no opinion (wasm blocked, undecodable audio), and no opinion keeps every
  // word: this filter may only ever take words away, never rescue a caption run.
  const kept = track ? dropWordsWithoutVoice(heard, track) : heard
  // Then the song filter, which answers a different question from the one above.
  // The voice detector asks "is anything voiced here" and cannot tell a band
  // from him, measured: a rigid bed reads 18.3 percent voiced against 17.7 for
  // clean speech. This one asks a classifier "is somebody TALKING here", and on
  // the same fixtures the worst case containing his voice outscores the best
  // case containing none by twenty times. → D123.
  const withoutSongs = dropWordsInMusic(kept, musicTrack)
  // Then the keyword highlight, in clip time, where these words and that
  // envelope share one clock. After the voice filter on purpose: a word the
  // audio says nobody said must not be able to win the colour.
  const marked: CaptionWord[] = envelope ? markEmphasis(withoutSongs, envelope) : withoutSongs
  // ⛔ THEN HIS PAUSES ARE MADE REAL, for captions. His words, 2026-09-28:
  // *"sometimes I just take a big pause between the words, and it still groups
  // them together."* The chunker already breaks on any pause, but Whisper pads a
  // word through the silence after it, so the pause never reached it.
  //
  // AFTER the filters above, never before. They were tuned on the recogniser's
  // own timings, and the voice filter keeps a word when a neighbour sits close
  // to it, so shortening the neighbours first would widen those gaps and let it
  // delete more of what he said. After the highlight too, so the picker keeps
  // the timings it was measured on. That is safe for its one-flag-per-caption
  // promise, because trimming only ever widens a gap: it can split a caption,
  // never join two.
  //
  // ⛔ AND FIRST EVERY WORD IS PUT WHERE HE SAID IT, for captions. His words,
  // 2026-10-04: *"Timing between captions"*. Measured against his own voice,
  // the recogniser stamps every word about a fifth of a second late, so every
  // caption came on after he had started the word (wordTiming.ts). The lag is
  // taken off before the pauses are looked for, so the pause search sees the
  // words where they are, and a word that opens a phrase then lands on the
  // frame his voice comes on.
  //
  // The silence cutter keeps the recogniser's timings: its air either side of
  // a cut is tuned against them.
  //
  // ⛔ THE WORDS TAB GETS THE LAG TAKEN OFF TOO, NOT THE TRIM (CA-9). It cuts
  // from a word's start to the next word's start, so with every word a fifth of
  // a second late the first fifth of the cut word stayed in the edit and the
  // first fifth of the next one went ("ey" for "hey"). It has no air to protect.
  // It does not get the trim, because a cut must take the whole word, tail and all.
  const needOnTime = opts.trimToVoice || opts.onSpoken
  const unlagged = needOnTime ? correctWordLag(marked, whisperModel(modelFor(getCaptionLanguage())).wordLagS) : marked
  const onTime = needOnTime && loudness ? meetAtDips(unlagged, loudness, DIP_ENVELOPE_HOP_S) : unlagged
  if (opts.onSpoken) {
    // In the media's own seconds, from the clip as it was heard (its in point),
    // so a clip moved or trimmed since cannot shift them.
    const said = track ? snapOnsetsToVoice(onTime, track) : onTime
    opts.onSpoken(
      said.filter((w) => clip.inS + w.startS < clip.outS).map((w) => ({ text: w.text, startS: clip.inS + w.startS, endS: clip.inS + w.endS })),
    )
  }
  if (!opts.trimToVoice) return timelineWords(marked, clip)
  const timed = track ? snapOnsetsToVoice(trimWordsToVoice(onTime, track), track) : onTime
  return timelineWords(timed, clip)
}

/** The recogniser's measured lag for the language he picked (wordTiming.ts). */
export const wordLagNow = (): number => whisperModel(modelFor(getCaptionLanguage())).wordLagS

/** What a caption door is asked for beyond listening. */
export interface CaptionRunOptions {
  /**
   * His own script (CA-6). The clips are heard for the TIMING only, and the
   * words laid down are his, in his spelling and punctuation (scriptAlign.ts).
   */
  script?: string
}

/** What a sweep says of clips deleted from the timeline while it was running. */
const vanishedMessage = (n: number): string =>
  `${n} clip${n === 1 ? '' : 's'} left the timeline while this ran, so ${n === 1 ? 'it was' : 'they were'} skipped`

/** Said when none of his script was heard in the clips, so nothing was laid. */
export const SCRIPT_NOT_HEARD = 'None of your script was heard there, so nothing was captioned. Select the clips you said it in'

/**
 * Lay what a door heard as captions: the recogniser's words, or his script
 * timed by them. One dispatch, one undo step, the same for every door.
 *
 * ⛔ A SCRIPT RUN IS HIS WORDS, NOT THE MACHINE'S. It carries no model, so no
 * caption is stamped as what the recogniser wrote: his vocabulary never learns a
 * "correction" from his own script, and no spelling of his is offered back to him.
 *
 * ⛔ AND IT REPLACES ONLY THE CLIPS HIS SCRIPT LANDED IN. "Caption the voiceover"
 * hears every take, and a script for one take used to be laid over all of them:
 * every other take's captions went, replaced by nothing.
 */
function layCaptions(
  words: CaptionWord[],
  o: {
    label: string
    style: CaptionStyle
    coveredSpans: { startS: number; endS: number }[]
    heard: { assetId: string; fromS: number; toS: number; words: SpokenWord[] }[]
    vocabulary: Vocabulary | undefined
    script?: string
  },
): void {
  if (o.script === undefined) {
    addCaptionsFromWords(words, {
      label: o.label,
      style: o.style,
      model: modelFor(getCaptionLanguage()),
      coveredSpans: o.coveredSpans,
      heard: o.heard,
      wordLagS: wordLagNow(),
      vocabulary: o.vocabulary,
    })
    return
  }
  const read = scriptHeard(o.script, words, o.coveredSpans)
  if (!read) {
    useToasts.getState().show(SCRIPT_NOT_HEARD, 'danger')
    return
  }
  // ⛔ ONLY THE TAKES THE SCRIPT LANDED IN (S-1). A stray word of it in a take of
  // ad-libbing must not replace that take's captions; it is dropped and counted.
  const { words: timed, dropped } = keepHitTakes(read.words, words, o.coveredSpans)
  const landed = o.coveredSpans.filter((sp) => timed.some((w) => w.startS >= sp.startS - 1e-9 && w.startS < sp.endS - 1e-9))
  addCaptionsFromWords(timed, {
    label: 'Captions from your script',
    style: o.style,
    coveredSpans: landed.length > 0 ? landed : o.coveredSpans,
    heard: o.heard,
    wordLagS: wordLagNow(),
  })
  const unheard = scriptUnheardMessage(read.unheardLines, read.unheardWords + dropped)
  if (unheard) useToasts.getState().show(unheard)
}

/**
 * What of his script was not heard in the clips, so has no caption (R-2):
 * lines cut from the edit, a hook moved, or script for other clips. Null when
 * every word was heard.
 */
export function scriptUnheardMessage(lines: number, words: number): string | null {
  const parts = [
    ...(lines > 0 ? [`${plural(lines, 'line')}${words > 0 ? '' : ' of your script'}`] : []),
    ...(words > 0 ? [`${plural(words, lines > 0 ? 'more word' : 'word', lines > 0 ? 'more words' : 'words')} of your script`] : []),
  ]
  if (parts.length === 0) return null
  return `${parts.join(' and ')} ${lines + words === 1 ? 'was' : 'were'} not heard there, so ${lines + words === 1 ? 'it has' : 'they have'} no captions`
}

/**
 * What the caption doors listen with. Test seam: the end to end suite puts a
 * stand in here so a caption run can be driven through the real menus without
 * downloading a speech model. Nothing else ever writes to it.
 */
export const captionEars = { wordsForClip }

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
  /** Sounding clips passed over because they play BACKWARDS (or not at all, speed 0). */
  skippedReversed: number
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

  // ⛔ ONLY A CLIP PLAYING FORWARDS (2026-09-23, from the open caption findings).
  // A reversed clip's sound is his voice backwards: the recogniser either finds
  // nothing or invents words, and the ones it finds were laid down forwards, so
  // content and order were both wrong. Speed 0 makes no sound at all in the mixer
  // (computeClipSchedule refuses it), and captioning silence is how imaginary
  // words get in. Both are counted and said, never dropped quietly.
  const forward = (x: { clip: Clip }): boolean => x.clip.speed > 0

  const audible = seq.tracks.filter((t) => heard(t) && !t.locked)
  const all = seq.tracks.flatMap(sounding)
  const eligible = audible
    .filter((t) => t.audioRole !== 'music')
    .flatMap(sounding)
    .filter(playing)
  const targets = eligible.filter(forward).sort((a, b) => a.clip.startS - b.clip.startS)

  return {
    targets,
    skippedReversed: eligible.length - targets.length,
    skippedMusic: audible.filter((t) => t.audioRole === 'music').flatMap(sounding).filter(playing).length,
    skippedLocked: seq.tracks.filter((t) => t.locked && heard(t)).flatMap(sounding).filter(playing).length,
    // Whatever is left over: muted, unsoloed, or switched off. Counted by
    // difference so a fourth reason added later cannot go unreported.
    skippedSilent:
      all.length -
      eligible.length -
      audible.filter((t) => t.audioRole === 'music').flatMap(sounding).filter(playing).length -
      seq.tracks.filter((t) => t.locked && heard(t)).flatMap(sounding).filter(playing).length,
  }
}

/** Transcribe the audio clip locally and lay its words down as captions. */
export async function autoCaptionFromClip(clipId: string, style?: CaptionStyle, run: CaptionRunOptions = {}): Promise<void> {
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
    toasts.show('Select an audio clip with sound to caption', 'info')
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
  // Backwards or stopped: see audibleClips. Pointing at it on purpose does not
  // change what the recogniser can do with reversed speech, so this door refuses
  // too, and says why.
  if (clip.speed <= 0) {
    toasts.show(clip.speed < 0 ? 'This clip plays backwards, so there are no words to caption' : 'This clip is stopped, so there is no sound to caption', 'danger')
    return
  }

  const job = claimJob()
  if (!job) {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  const vocabulary = currentVocabulary()
  try {
    let spoken: SpokenWord[] | null = null
    const heard = await captionEars.wordsForClip(clip, asset, {
      trimToVoice: true,
      vocabulary,
      job,
      onSpoken: (w) => {
        spoken = w
      },
    })
    stopIfAsked(job)
    // Read by now: the words above waited for it. Its spellings fixed once go to the toast.
    const learned = await vocabulary
    stopIfAsked(job)
    // ⛔ READ THE CLIP AGAIN AFTER LISTENING, as the sweep does. Listening takes
    // seconds and the timeline is not blocked, so a clip he dragged meanwhile
    // was captioned at the spot it USED to sit. A move only shifts the words.
    // A trim or a speed change means the words no longer match the clip, and
    // guessing would put captions on the wrong words, so nothing is laid.
    const live = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clipId)
    const shift = live ? live.startS - clip.startS : 0
    const words = shift === 0 ? heard : heard.map((w) => ({ ...w, startS: w.startS + shift, endS: w.endS + shift }))
    if (!live || live.inS !== clip.inS || live.outS !== clip.outS || live.speed !== clip.speed || live.assetId !== clip.assetId) {
      toasts.show(
        live ? 'That clip changed while it was being heard, so nothing was captioned' : 'That clip left the timeline while it was being heard, so nothing was captioned',
        'danger',
      )
    } else if (words.length === 0) {
      toasts.show(NOBODY_TALKS, 'info')
    } else {
      // No style passed (the right-click door) falls back to his DEFAULT style,
      // so every door produces the same captions.
      layCaptions(words, {
        label: 'Auto-caption from voiceover',
        style: style ?? defaultCaptionStyle(),
        // The clip it heard, not the box around the words it found: a re-run
        // replaces every old caption in this clip, and none in the next one.
        coveredSpans: [{ startS: live.startS, endS: clipEndS(live) }],
        // And what it heard goes on the media for the Words tab, same undo step.
        heard: spoken ? [{ assetId: asset.id, fromS: clip.inS, toS: clip.outS, words: spoken }] : [],
        vocabulary: learned,
        script: run.script,
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
      toasts.show(captionFailureMessage(err, job.downloaded), 'danger')
      console.error('auto-caption:', err)
    }
  } finally {
    releaseJob(job)
  }
}

/**
 * Listen to ONE clip and hand back its words in the media's own seconds,
 * through the same doors, toasts and tidy up as Auto-caption, but WITHOUT laying
 * captions down. The Words panel keeps what it hears on the media
 * (transcriptActions.ts), so this is the one listening that both captions and
 * cutting by words share. `clip` is the clip as it was HEARD: a clip moved while
 * the model worked used to have its words mapped back through where it had
 * moved to, and every clip cut from that media then read the wrong seconds.
 * Null when the run was refused, cancelled, or heard nothing.
 */
export async function listenToClip(
  clipId: string,
): Promise<{ clip: Clip; asset: MediaAsset; words: SpokenWord[] } | null> {
  const toasts = useToasts.getState()
  if (useTranscribe.getState().status !== 'idle') {
    toasts.show('A transcription is already running', 'danger')
    return null
  }
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset?.hasAudio) {
    toasts.show('That clip has no sound to listen to', 'danger')
    return null
  }
  // ⛔ THE SAME REFUSAL autoCaptionFromClip GOT ON 2026-09-23, and this door had
  // none. Both call wordsForClip, and a reversed clip's audio is extracted
  // FORWARD (extractClipPcm does not know about playback direction), so Whisper
  // hears it correctly, but timelineWords places the words assuming forward
  // playback too: it maps them onto the timeline using |speed|, never the sign.
  // That is exactly backwards for a reversed clip, and this door feeds the
  // result straight into transcriptActions.toSource, corrupting the asset's
  // stored words with positions that do not match how the clip actually plays.
  // Speed 0 makes no sound in the mixer at all, so there is nothing to hear.
  if (clip.speed <= 0) {
    toasts.show(
      clip.speed < 0
        ? 'This clip plays backwards, so there are no words to listen for'
        : 'This clip is stopped, so there is no sound to listen for',
      'danger',
    )
    return null
  }
  const job = claimJob()
  if (!job) {
    toasts.show('A transcription is already running', 'danger')
    return null
  }
  try {
    let spoken: SpokenWord[] = []
    const words = await wordsForClip(clip, asset, {
      vocabulary: currentVocabulary(),
      job,
      onSpoken: (w) => {
        spoken = w
      },
    })
    if (words.length === 0) {
      toasts.show(NOBODY_TALKS, 'info')
      return null
    }
    return { clip, asset, words: spoken }
  } catch (err) {
    if (!isCancel(err)) {
      toasts.show(captionFailureMessage(err, job.downloaded), 'danger')
      console.error('listen for words:', err)
    }
    return null
  } finally {
    releaseJob(job)
  }
}

/**
 * One clip's words for "Cut the quiet parts", through the same door as the
 * others: it waits its turn and always puts the status back.
 *
 * ⛔ THE CUTTER USED TO CALL wordsForClip BARE. Nothing put the status back
 * after it, so the listening pill stayed on screen and every caption door and
 * the Words panel said "A transcription is already running" until a restart;
 * and nothing stopped it starting while another run was going.
 *
 * His spellings are applied like the Words panel's, so what the cutter hears is
 * what the Words panel would keep. `queue` says which clip of how many, when
 * the cutter runs on a selection. Null when another run is going. A failure
 * throws, for the cutter to say in its own words.
 */
export async function wordsForCut(
  clip: Clip,
  asset: MediaAsset,
  queue: { index: number; total: number } | null = null,
): Promise<CaptionWord[] | null> {
  const job = claimJob(queue)
  if (!job) return null
  try {
    return await wordsForClip(clip, asset, { vocabulary: currentVocabulary(), job })
  } finally {
    releaseJob(job)
  }
}

/**
 * Listen to several clips one after another for the Words tab, and hand back
 * what each said in its media's own seconds. One job with "clip 2 of 5", one
 * Stop for all of them, and a clip that fails is counted rather than ending the
 * rest. The caller keeps the words (transcriptActions.listenForEveryClip).
 */
export async function listenToClips(ids: readonly string[]): Promise<{ clip: Clip; asset: MediaAsset; words: SpokenWord[] }[]> {
  const toasts = useToasts.getState()
  const job = claimJob({ index: 1, total: ids.length })
  if (!job) {
    toasts.show('A transcription is already running', 'danger')
    return []
  }
  const out: { clip: Clip; asset: MediaAsset; words: SpokenWord[] }[] = []
  let failed = 0
  try {
    const vocabulary = currentVocabulary()
    for (let i = 0; i < ids.length; i++) {
      if (job.stopped) break
      const s = useStore.getState()
      const clip = activeSequence(s.project)
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === ids[i])
      const asset = clip ? s.project.assets[clip.assetId] : undefined
      // Gone, silent, or backwards (see listenToClip): nothing to hear.
      if (!clip || !asset?.hasAudio || clip.speed <= 0) continue
      useTranscribe.setState({ queue: { index: i + 1, total: ids.length } })
      try {
        let spoken: SpokenWord[] = []
        await captionEars.wordsForClip(clip, asset, {
          vocabulary,
          job,
          onSpoken: (w) => {
            spoken = w
          },
        })
        out.push({ clip, asset, words: spoken })
      } catch (err) {
        if (isCancel(err)) break
        failed++
        console.error('listen to every clip:', err)
      }
    }
  } finally {
    releaseJob(job)
  }
  if (failed > 0) toasts.show(`${failed} clip${failed === 1 ? '' : 's'} could not be read`, 'danger')
  return out
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
  style?: CaptionStyle,
  /** When given, caption only these clips. Used by the right-click on a selection. */
  onlyIds?: ReadonlySet<string>,
  run: CaptionRunOptions = {},
): Promise<void> {
  const toasts = useToasts.getState()
  if (useTranscribe.getState().status !== 'idle') {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  const { targets, skippedMusic, skippedLocked, skippedSilent, skippedReversed } = audibleClips(onlyIds)
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
            : skippedReversed > 0
              ? 'Nothing to caption, the clips with sound play backwards'
            : onlyIds
              ? 'None of those clips have sound'
              : 'No clips with sound to caption',
      'danger',
    )
    return
  }

  const words: CaptionWord[] = []
  // ⛔ ONE SPAN PER CLIP THIS RUN ACTUALLY LISTENED TO, NOT ONE BOX AROUND ALL
  // OF THEM. The words above are pooled flat for one dispatch, which used to
  // lose every clip boundary: addCaptionsFromWords then took the single
  // min/max of the whole pooled run as "the stretch it covers" and wiped
  // anything sitting between two captioned clips, including a caption he had
  // hand corrected on a clip this run never touched (a skipped music bed or a
  // clip nobody selected, sitting between two he did). Recorded only once a
  // clip is actually heard (not on a vanished or failed one), so a transient
  // failure never wipes what was already there with nothing to replace it.
  const coveredSpans: { startS: number; endS: number }[] = []
  /** What each heard clip said, for the media (the Words tab), in the same undo step. */
  const spokenOn: { assetId: string; fromS: number; toS: number; words: SpokenWord[] }[] = []
  const job = claimJob({ index: 1, total: targets.length })
  if (!job) {
    toasts.show('A transcription is already running', 'danger')
    return
  }
  // Once for the whole sweep: it is the same vocabulary for every clip, read
  // while the first clip is heard rather than before it.
  const vocabulary = currentVocabulary()
  let learned: Vocabulary | undefined
  let cancelled = false
  let failed = 0
  let vanished = 0
  /** Clips nobody said anything in. Counted so the run can say so instead of looking short. */
  let silent = 0
  try {
    for (let i = 0; i < targets.length; i++) {
      // Stop pressed while the last clip finished: what it heard stays, no more.
      if (job.stopped) {
        cancelled = true
        break
      }
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
        const heard = await captionEars.wordsForClip(live, asset, {
          screenFirst: true,
          trimToVoice: true,
          vocabulary,
          job,
          onSpoken: (w) => void spokenOn.push({ assetId: asset.id, fromS: live.inS, toS: live.outS, words: w }),
        })
        if (heard.length === 0) silent++
        words.push(...heard)
        coveredSpans.push({ startS: live.startS, endS: clipEndS(live) })
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
    // Read by now: every clip heard waited for it. Its spellings fixed once go to the toast.
    learned = await vocabulary
  } finally {
    releaseJob(job)
  }

  if (words.length === 0) {
    // N-7 (CA-20). Stopping is his choice and a silent timeline is a fact, so
    // neither comes up red. Clips that could not be read are the failure, and
    // are named as one rather than passed off as "no speech".
    if (cancelled) toasts.show('Stopped before anything was heard', 'info')
    else if (failed > 0) toasts.show(`${failed} clip${failed === 1 ? '' : 's'} could not be read`, 'danger')
    // A clip that left the timeline was never heard: "no speech in any clip" would hide it.
    else if (vanished > 0) toasts.show(vanishedMessage(vanished))
    else toasts.show('No speech found in any clip', 'info')
    return
  }
  layCaptions(words, {
    label: onlyIds ? 'Auto-caption selected clips' : 'Auto-caption every clip',
    style: style ?? defaultCaptionStyle(),
    coveredSpans,
    heard: spokenOn,
    vocabulary: learned,
    script: run.script,
  })
  if (cancelled) toasts.show('Stopped early, captioned what was heard so far')
  else if (failed > 0) toasts.show(`${failed} clip${failed === 1 ? '' : 's'} could not be read`, 'danger')
  // Deleting a clip while the run is working through the timeline is a perfectly
  // reasonable thing to do, and silently captioning one fewer clip than the
  // counter promised is not. Said plainly, and not as a failure, because nothing
  // failed.
  else if (vanished > 0) {
    toasts.show(vanishedMessage(vanished))
  }
  // Why forty one clips produced captions from six of them. Without this the run
  // looks like it quietly missed most of the timeline.
  else if (silent > 0) {
    toasts.show(`${silent} clip${silent === 1 ? '' : 's'} had nobody talking, so ${silent === 1 ? 'it was' : 'they were'} passed over`)
  }
}
