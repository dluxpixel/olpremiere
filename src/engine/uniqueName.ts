// A name nothing else has yet: `base`, then `base_1`, `base_2` and on.
//
// His words, 2026-09-28: *"Make it like _1 _2 ... like photoshop"*, for exports
// AND *"when you're saving projects"*. Every new project used to be called
// "Untitled Project", so every export of every one of them suggested the same
// file name and Windows asked to replace the last one.

export function nextFreeName(base: string, taken: ReadonlySet<string>): string {
  const clean = base.trim() || 'Untitled Project'
  if (!taken.has(clean)) return clean
  for (let n = 1; n < 100_000; n++) {
    const next = `${clean}_${n}`
    if (!taken.has(next)) return next
  }
  return `${clean}_${Date.now()}`
}
