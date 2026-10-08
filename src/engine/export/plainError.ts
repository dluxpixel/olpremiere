// What a failed export says to him: one plain line he can act on, with the machine's own words
// kept behind "Details" and in the usage log, where they help whoever reads them later.
//
// ⛔ IT USED TO SHOW THE MACHINE TEXT ITSELF: "Native export failed while initializing renderer:
// WebGL2 is unavailable in this worker, cannot export", or "ffmpeg exited during export (exit code
// -28): [out#0/mp4 @ ...]". He records on a drive the app itself knows is nearly full, so "No space
// left on device" buried in an ffmpeg tail is a likely one, and he could not have found it there
// (export audit, 2026-10-06). Pure.

export interface PlainExportError {
  /** The first line, in plain words. */
  line: string
  /** The raw text, for the Details toggle. Null when the line already IS the whole message. */
  details: string | null
  /** True when the cause is unknown and the line only says it stopped. */
  generic: boolean
}

/** The line for a file that could not be written where he chose: Try again asks for another place. */
export const CANNOT_WRITE_THERE = 'Could not write the file there. Choose another folder and try again.'

const RULES: { test: RegExp; say: (m: RegExpExecArray) => string }[] = [
  {
    test: /no space left on device|ENOSPC|not enough space on the disk|disk (?:is )?full/i,
    say: () => 'There is no room left on the disk. Free some space and try again.',
  },
  {
    test: /out of memory|cannot allocate memory|ENOMEM|allocation failed/i,
    say: () => 'The computer ran out of memory. Close some apps and try again.',
  },
  {
    test: /WebGL2? is unavailable|graphics context was lost|context lost|GPU process/i,
    say: () => 'The graphics card stopped during the export. Try again.',
  },
  {
    test: /could not read video "([^"]+)"/i,
    say: (m) => `Could not read the video ${m[1]}.`,
  },
  {
    test: /could not decode image "([^"]+)"/i,
    say: (m) => `Could not read the picture ${m[1]}.`,
  },
  {
    // The bundled ffmpeg.exe gone, quarantined by an antivirus, or not allowed to run.
    test: /could not start ffmpeg|spawn .*ffmpeg.* (?:ENOENT|EACCES|EPERM|UNKNOWN)/i,
    say: () => 'The video maker is missing or blocked. Reinstall OL Premiere.',
  },
  {
    test: /Error opening output|No such file or directory|Permission denied|EACCES|EPERM/i,
    say: () => CANNOT_WRITE_THERE,
  },
]

/** Machine text: anything with these in it was not written for him. */
const MACHINE = /ffmpeg|worker|exit(?:ed)? code|exited|export failed while|Error:|DOMException|isConfigSupported|undefined|\[\w+[#@ ]|0x[0-9a-f]{4,}|\bat \S+ \(/i

export function plainExportError(raw: string): PlainExportError {
  const text = raw.trim()
  for (const rule of RULES) {
    const m = rule.test.exec(text)
    if (m) return { line: rule.say(m), details: text, generic: false }
  }
  // The app's own messages are already written for him ("clip.mp4" is not on this computer...):
  // they stay exactly as they are. They read as sentences; internal ones ("frame write failed") do not.
  if (/^["“\p{Lu}]/u.test(text) && !MACHINE.test(text)) return { line: text, details: null, generic: false }
  return { line: 'The export stopped. Try again.', details: text || null, generic: true }
}
