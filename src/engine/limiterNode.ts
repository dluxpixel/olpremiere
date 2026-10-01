// Builds the preview's master limiter node: the AudioWorklet in
// limiterWorklet.ts, which runs the export's own TruePeakLimiter. Kept apart
// from audio.ts and imported only on demand, because the worklet URL means
// something only to a real AudioContext.

import { LIMITER_PROCESSOR } from './audioLimiter'
import limiterWorkletUrl from './limiterWorklet.ts?worker&url'

export async function createLimiterNode(ctx: BaseAudioContext): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(limiterWorkletUrl)
  return new AudioWorkletNode(ctx, LIMITER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    // Always two channels in: a mono sum is spread to both sides first, the way
    // the destination would have, so the limiter sees what the speakers get.
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  })
}
