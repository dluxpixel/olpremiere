// The live preview's master limiter: the SAME TruePeakLimiter the export runs
// on its rendered PCM (export/audioRender.ts), here inside an AudioWorklet on
// the master bus. One implementation, so what he hears while editing is what
// the file gets. Loaded by limiterNode.ts; its delay is taken off by starting
// every source that much early (audio.ts scheduleAudio), so nothing is late.

import { LIMITER_PROCESSOR, TruePeakLimiter } from './audioLimiter'

// The AudioWorkletGlobalScope is not in TypeScript's DOM library.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void

class TruePeakLimiterProcessor extends AudioWorkletProcessor {
  private limiter: TruePeakLimiter | null = null

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    this.limiter ??= new TruePeakLimiter(output.length, sampleRate)
    // An input with nothing connected arrives with no channels: silence, which
    // still has to run through, or the delay line would hold the last sound.
    this.limiter.process(inputs[0] ?? [], output, output[0].length)
    return true
  }
}

registerProcessor(LIMITER_PROCESSOR, TruePeakLimiterProcessor)
