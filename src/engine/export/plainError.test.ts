import { describe, expect, it } from 'vitest'
import { plainExportError } from './plainError'

describe('a failed export says why in plain words', () => {
  // Every raw string here is one the export really produces (export audit, 2026-10-06).
  const cases: [string, string][] = [
    [
      'ffmpeg exited during export (exit code -28): [out#0/mp4 @ 0000020c] Error writing trailer: No space left on device',
      'There is no room left on the disk. Free some space and try again.',
    ],
    [
      'ffmpeg exited during export (exit code -12): [vost#0:0/libx264 @ 00000] Cannot allocate memory',
      'The computer ran out of memory. Close some apps and try again.',
    ],
    ['Array buffer allocation failed', 'The computer ran out of memory. Close some apps and try again.'],
    [
      'Native export failed while initializing renderer: WebGL2 is unavailable in this worker, cannot export',
      'The graphics card stopped during the export. Try again.',
    ],
    [
      'Native export failed while rendering frame 812: the graphics context was lost during the export, so the frames would have come out black',
      'The graphics card stopped during the export. Try again.',
    ],
    [
      'Native export failed while decoding: could not read video "IMG_5001.MOV": Unsupported configuration. Check isConfigSupported() prior to calling configure().',
      'Could not read the video IMG_5001.MOV.',
    ],
    ['Native export failed while decoding: could not decode image "logo.png"', 'Could not read the picture logo.png.'],
    ['could not start ffmpeg', 'The video maker is missing or blocked. Reinstall OL Premiere.'],
    [
      'could not start ffmpeg: spawn C:\\Program Files\\OL Premiere\\resources\\ffmpeg\\ffmpeg.exe ENOENT',
      'The video maker is missing or blocked. Reinstall OL Premiere.',
    ],
    [
      'ffmpeg exited during export (exit code -2): [out#0/mp4 @ 000001] Error opening output D:\\gone\\x.mp4: No such file or directory',
      'Could not write the file there. Choose another folder and try again.',
    ],
    ['Export worker crashed: unknown error', 'The export stopped. Try again.'],
    ['ffmpeg exited with code 1: Conversion failed!', 'The export stopped. Try again.'],
    ['frame write failed', 'The export stopped. Try again.'],
  ]

  it.each(cases)('%s', (raw, line) => {
    const plain = plainExportError(raw)
    expect(plain.line).toBe(line)
    // The machine's words are kept, for Details and the usage log.
    expect(plain.details).toBe(raw)
  })

  it('only the unknown ones are generic', () => {
    expect(plainExportError('Export worker crashed: unknown error').generic).toBe(true)
    expect(plainExportError('ffmpeg exited during export: No space left on device').generic).toBe(false)
  })

  it("keeps the app's own plain messages exactly as they are", () => {
    for (const msg of [
      '"clip.mp4" is not on this computer. Find my media in the Media panel puts it back',
      'Could not read the sound from clip.mp4. Re-import it and try again.',
      'Nothing to export: the range is empty',
    ]) {
      expect(plainExportError(msg)).toEqual({ line: msg, details: null, generic: false })
    }
  })
})
