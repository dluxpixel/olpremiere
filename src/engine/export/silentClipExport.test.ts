// A video with no sound must still export.
//
// Found 2026-09-11, mapping what happens to somebody who is not David. Gameplay
// with the mic off, a screen recording, a phone clip shot in silent mode: none of
// them could be exported AT ALL, and the message sent him to re-import the file,
// which hands back the same silent file.
//
// The cause is two reasonable decisions meeting: `probe.ts` cannot tell whether a
// video carries audio at `preload=metadata` (Chromium exposes no `mozHasAudio`,
// no `audioTracks`, and a zero decoded-byte counter), so it returns TRUE and says
// in a comment that this is an honest default. `audioRender` then reads that
// guess as a CLAIM: "this file says it has sound, we got none, refuse to export".
//
// ⛔ AND THE GUARD IT RUNS INTO MUST NOT SIMPLY BE WEAKENED. It exists because of
// his own report on 2026-08-05: *"to export audio doesn't work. It just didn't
// export the audio."* A silent success is the worst outcome available, because he
// only finds out after uploading. So the fix is not to stop refusing, it is to
// tell PROOF from a guess.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const audioSrc = readFileSync(fileURLToPath(new URL('../audio.ts', import.meta.url)), 'utf8')
const renderSrc = readFileSync(fileURLToPath(new URL('./audioRender.ts', import.meta.url)), 'utf8')

describe('only a missing TRACK counts as proof of silence', () => {
  it('records an asset as silent when the container holds no audio stream', () => {
    // The demuxer opened the file and there was no audio track in it. That is a
    // fact about the file, not a guess about it, which is the whole distinction.
    const branch = audioSrc.slice(audioSrc.indexOf('const track = await input.getPrimaryAudioTrack()'))
    expect(branch.slice(0, 400)).toContain('provedSilent.add(asset.id)')
  })

  it('⛔ does NOT record one whose track merely cannot be decoded here', () => {
    // A codec this build cannot handle is a real failure and has to stay loud.
    // If `canDecode` ever starts feeding provedSilent, an unreadable soundtrack
    // becomes a silently silent export, which is the 2026-08-05 scar exactly.
    const i = audioSrc.indexOf('if (!(await track.canDecode())) return null')
    expect(i).toBeGreaterThan(-1)
    const decodeBranch = audioSrc.slice(i, i + 200)
    expect(decodeBranch).not.toContain('provedSilent')
  })

  it('keeps the proof in one place, so nothing can set it by another route', () => {
    // Two writers would let a future change mark an unreadable file silent from
    // somewhere this test is not looking.
    expect(audioSrc.match(/provedSilent\.add/g) ?? []).toHaveLength(1)
  })
})

describe('the export refuses only when something really did lose its sound', () => {
  it('leaves a proved-silent clip out of the files it would refuse over', () => {
    const i = renderSrc.indexOf('const names = [')
    expect(i).toBeGreaterThan(-1)
    expect(renderSrc.slice(i, i + 300)).toContain('!isProvedSilent(c.asset.id)')
  })

  it('leaves it out of the partial-audio warning too', () => {
    // Otherwise every silent clip would raise "no sound from 1 clip" on an
    // export that is behaving perfectly.
    const i = renderSrc.indexOf('const failed = candidates.filter')
    expect(i).toBeGreaterThan(-1)
    expect(renderSrc.slice(i, i + 300)).toContain('!isProvedSilent')
  })

  it('⛔ still throws when a file that really has sound could not be read', () => {
    // The guard itself is untouched: the list it builds is narrower, the
    // consequence of a non-empty list is the same loud stop it always was.
    const i = renderSrc.indexOf('const names = [')
    const after = renderSrc.slice(i, i + 900)
    expect(after).toContain('if (names.length === 0) return null')
    expect(after).toContain('throw new Error(')
    expect(after).toContain('Could not read the sound from')
  })
})
