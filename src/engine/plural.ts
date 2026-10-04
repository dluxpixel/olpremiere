/**
 * A count with the noun that agrees with it: "1 clip", "2 clips", "0 clips".
 *
 * His ask, 2026-10-03, after the right-click menu on one selected clip said "Delete 1 clips":
 * a count in a sentence must agree with one. Most of the app spells this inline
 * (`${n} clip${n === 1 ? '' : 's'}`), which is exactly the thing that gets forgotten, so a label
 * that shows a count goes through here. `many` is for nouns that do not just add an s.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
