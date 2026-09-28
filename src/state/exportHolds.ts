// Media a running export still reads, so nothing deletes it underneath.
//
// An export used to own the whole screen, so nothing else could happen while it
// ran. Now it runs in the background while he edits, switches projects and
// deletes things. His words, 2026-09-28: *"Make it so that while the video is
// exporting, I can work on other videos too, because the export time is
// sometimes very long."*
//
// That opens a gap the modal used to close by accident. The export freezes a
// copy of the project when he presses Export, and that copy can point at media
// no stored project points at any more: he deletes a clip from the bin, or
// deletes the whole project he is exporting. The two places that throw bytes
// away (deleting a project, and the orphan sweep) both decide by asking the
// stored projects, so both would have pulled the footage out from under the
// running file. They ask here too, and a held key is left alone. It is not
// lost: once the export lets go, the next sweep finds it unreachable and
// reclaims it the ordinary way.
//
// A leaf module on purpose: persistence and the sweep import it, and the export
// controller imports both of them, so living anywhere else would be a cycle.

const holds = new Map<string, number>()

/**
 * Keep these media keys safe until the returned release is called. Counted, so
 * two holds on the same key (a retry overlapping its own cleanup) need two
 * releases before the key can go.
 */
export function holdBlobKeys(keys: Iterable<string>): () => void {
  const held = [...new Set(keys)]
  for (const k of held) holds.set(k, (holds.get(k) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const k of held) {
      const n = (holds.get(k) ?? 0) - 1
      if (n > 0) holds.set(k, n)
      else holds.delete(k)
    }
  }
}

/** Is a running export still reading this key? */
export function isBlobHeld(key: string): boolean {
  return holds.has(key)
}
