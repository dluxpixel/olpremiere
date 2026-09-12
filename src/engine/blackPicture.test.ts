// A black picture must say why, and a black export must refuse.
//
// Found 2026-09-11 by asking what happens on a machine that is not his. The
// preview cached a null renderer when WebGL2 was unavailable, said nothing when
// getContext itself returned null, and reported the frame as complete, so the
// Monitor sat on a black rectangle with no message anywhere. The export was
// worse: readPixels is a no-op by spec on a lost context, so a driver reset
// mid-export would send ffmpeg a zero-filled buffer per frame and finish green.
// He would find out after uploading.
//
// He picked this as the next job on 2026-09-12: silent wrong is the worst kind.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const preview = readFileSync(fileURLToPath(new URL('./preview.ts', import.meta.url)), 'utf8')
const monitor = readFileSync(fileURLToPath(new URL('../components/Monitor.tsx', import.meta.url)), 'utf8')
const worker = readFileSync(fileURLToPath(new URL('./export/exportWorker.ts', import.meta.url)), 'utf8')

describe('the preview names the reason it cannot draw', () => {
  it('records a reason on BOTH ways a renderer can fail to exist', () => {
    // The null-context branch is the one that used to be silent: no exception,
    // so nothing downstream ever logged it.
    const fn = preview.slice(preview.indexOf('function rendererFor('), preview.indexOf('// Pair-transition pre-roll'))
    expect(fn).toContain('if (!gl) {')
    expect((fn.match(/noPictureReasons\.set\(/g) ?? []).length).toBe(2)
  })

  it('exposes the reason to the Monitor', () => {
    expect(preview).toContain('export function noPictureReason(')
  })

  it('the Monitor reads it right after the draw and puts it ON the picture', () => {
    const after = monitor.slice(monitor.indexOf('prevComplete = renderPreview('))
    expect(after.slice(0, 700)).toContain('noPictureReason(canvas)')
    // On the picture, not a toast: a toast vanishes and leaves the black behind.
    expect(monitor).toContain('data-testid="no-picture"')
    const overlay = monitor.slice(monitor.indexOf('data-testid="no-picture"'))
    expect(overlay.slice(0, 900)).toContain('Your edit is safe')
  })

  it('says it once, not on every frame', () => {
    expect(monitor).toContain('let reportedNoPicture = false')
    expect(monitor).toContain('if (!reportedNoPicture) {')
  })
})

describe('an export refuses to write black frames', () => {
  it('⛔ checks for a lost context before EVERY readback, on both export paths', () => {
    // readPixels (native path) and VideoFrame(canvas) (web path) are the two
    // places pixels leave the GPU. A guard on one and not the other is a black
    // video on whichever path he happens to be on.
    const native = worker.slice(worker.indexOf('gl.readPixels(') - 900, worker.indexOf('gl.readPixels('))
    expect(native).toContain('gl.isContextLost()')
    // The web path's readback is the LAST VideoFrame(canvas); the first is a
    // 2D-canvas bitrate probe that never touches GL and needs no guard.
    const webAt = worker.lastIndexOf('new VideoFrame(canvas')
    expect(worker.slice(webAt - 400, webAt)).toContain('gl.isContextLost()')
  })

  it('throws rather than returning, so the export fails loudly', () => {
    const guards = worker.match(/if \(gl\.isContextLost\(\)\) throw new Error\(/g) ?? []
    expect(guards).toHaveLength(2)
  })

  it('tells him what he would have got, in plain words', () => {
    expect(worker).toContain('the frames would have come out black')
  })
})
