// "Do this first" is a hint, not an error. Nothing failed when he has not picked a clip yet, and a
// red toast reads as "something broke". Red stays for what really failed: could not save, read,
// decode, import or write. This reads every toast in the app's source, so a new hint written as
// 'danger' fails here instead of shouting at him.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** The words a hint starts with: what to pick, select, type or do first. */
const HINT = /^(Select|Pick|Put the playhead|Nothing to paste|Copy a|Type at least|Set an In)/

/** A quoted string in source: '...', "..." or `...`, with escapes. */
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** The words of every red toast in this text that are a hint. */
function redHintsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/'danger'/g)) {
    const call = text.lastIndexOf('show(', m.index)
    if (call < 0 || m.index - call > 400) continue
    for (const lit of text.slice(call, m.index).matchAll(LITERAL)) {
      if (HINT.test(lit[2])) out.push(lit[2])
    }
  }
  return out
}

describe('a toast that says what to do first', () => {
  it('is never red', () => {
    const found = sources(SRC).flatMap((file) =>
      redHintsIn(readFileSync(file, 'utf8')).map((m) => `${file.slice(SRC.length)}: ${m}`),
    )
    expect(found).toEqual([])
  })

  it('is caught by this check when it is red, on one line or in a choice of two', () => {
    expect(redHintsIn("useToasts.getState().show('Select a clip to copy', 'danger')")).toEqual(['Select a clip to copy'])
    expect(redHintsIn("show(n === 0 ? 'Select a clip first' : 'Effects don’t apply to audio clips', 'danger')")).toEqual([
      'Select a clip first',
    ])
    expect(redHintsIn("show('Could not decode the audio', 'danger')")).toEqual([])
    expect(redHintsIn("show('Select a clip first', 'info')")).toEqual([])
  })
})
