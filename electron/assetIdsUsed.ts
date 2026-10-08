// What a project uses, by asset id: ONE definition for both halves of the spare
// copy cleanup (mediaSweep.ts). The page counts the store with it and main counts
// the project files in Projects, Trash and Backups with it.
//
// ⛔ ONE PLACE, ON PURPOSE. The two halves used to count differently: the page
// counted every id a clip points at, even one whose media record is gone, and main
// read only the media records. A clip like that in a project in Trash read as
// "unused" to main, and its footage's spare copy could go. Anything a project
// grows later is now counted on both sides or on neither.
//
// Shape tolerant, because main reads files from disk: whatever is not the shape
// it expects adds nothing here, and main refuses a file with no media list at all
// before it gets this far.

export function assetIdsUsedBy(project: unknown): string[] {
  const p = project as { assets?: unknown; sequences?: unknown } | null | undefined
  const ids = new Set<string>()
  if (p?.assets && typeof p.assets === 'object') {
    for (const [key, a] of Object.entries(p.assets as Record<string, unknown>)) {
      ids.add(key)
      const id = (a as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id) ids.add(id)
    }
  }
  if (p?.sequences && typeof p.sequences === 'object') {
    for (const seq of Object.values(p.sequences as Record<string, unknown>)) {
      const tracks = (seq as { tracks?: unknown } | null)?.tracks
      if (!Array.isArray(tracks)) continue
      for (const t of tracks) {
        const clips = (t as { clips?: unknown } | null)?.clips
        if (!Array.isArray(clips)) continue
        for (const c of clips) {
          const id = (c as { assetId?: unknown } | null)?.assetId
          if (typeof id === 'string' && id) ids.add(id)
        }
      }
    }
  }
  return [...ids]
}
