// Take a commit message on stdin, print it back with every em dash and en dash
// rewritten away, and nothing else touched. Used once as a `git filter-branch
// --msg-filter` to clean the published history (his call, 2026-07-27: no dashes
// anywhere, "they make it seem so AI").
//
// The rules are deliberately conservative, because a mechanical pass over 227
// messages has to be predictable:
//   "text — More text"   -> "text. More text"   (next word is capitalised, so it
//                                                was already a new sentence)
//   "text — more text"   -> "text, more text"
//   "word—word"          -> "word, word"
//   "0–51"               -> "0 to 51"           (a numeric range)
//   "— text" at line start -> "text"            (a dash used as a bullet)
// Anything a rule does not match is reported by --check rather than guessed at.

const DASH = /[—–]/

/** A range like 0–51 or 2–3x, where both sides are digits. */
function fixRanges(s) {
  return s.replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')
}

function fixLine(line) {
  let out = fixRanges(line)

  // A dash opening a line is a bullet marker; drop it and keep the text.
  out = out.replace(/^(\s*)[—–]\s+/, '$1')

  // Spaced dash between clauses.
  out = out.replace(/\s+[—–]\s+(\S)/g, (_m, next) =>
    /[A-Z0-9"'`(]/.test(next) && next !== 'I' ? `. ${next}` : `, ${next}`,
  )

  // Unspaced dash glued between two words.
  out = out.replace(/(\S)[—–](\S)/g, '$1, $2')

  // A trailing dash at end of line, nothing to join to.
  out = out.replace(/\s*[—–]\s*$/, '')

  return out
}

export function rewriteMessage(msg) {
  return msg
    .split('\n')
    .map((l) => (DASH.test(l) ? fixLine(l) : l))
    .join('\n')
}

// --- CLI -------------------------------------------------------------------

const chunks = []
for await (const c of process.stdin) chunks.push(c)
const input = Buffer.concat(chunks).toString('utf8')
const output = rewriteMessage(input)

if (process.argv.includes('--check')) {
  if (DASH.test(output)) {
    console.error('LEFTOVER DASH:\n' + output)
    process.exit(1)
  }
  if (output.trim() === '') {
    console.error('EMPTY MESSAGE after rewrite')
    process.exit(1)
  }
  process.stdout.write('ok\n')
} else {
  process.stdout.write(output)
}
