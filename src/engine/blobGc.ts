// Blob garbage collection PLANNER. Local-first storage grows forever otherwise:
// importing a video writes an 'asset/<id>' blob (and usually a 'thumb/<id>'
// poster), and deleteAsset intentionally KEEPS those blobs so an undo can bring
// the bin item back. Nothing ever reclaims them, so every video the user ever
// touched lives in IndexedDB until the origin is cleared.
//
// This module only DECIDES which stored keys are safe to delete; the caller does
// the actual IndexedDB writes. Pure: no React, no DOM, no store, no I/O.
//
// The one safety property that matters: be conservative. Only 'asset/' and
// 'thumb/' keys (the media a project owns) are ever eligible. Library blobs
// ('lib/' and 'lib-thumb/') have their own lifecycle and are owned by the global
// Library, not any project, so collecting them here would hole the Library. And an
// unrecognised prefix is NEVER an orphan: an unknown key might be written by a
// future feature whose reachability we cannot see, so deleting it would be data
// loss. When in doubt, keep the blob.

import type { Project } from './types'

/** Blob-key prefixes a project owns, and that this planner is allowed to reclaim. */
const PROJECT_MEDIA_PREFIXES = ['asset/', 'thumb/'] as const

/** True for keys this planner may ever consider deleting (project-owned media). */
const isProjectMediaKey = (key: string): boolean =>
  PROJECT_MEDIA_PREFIXES.some((prefix) => key.startsWith(prefix))

/**
 * Every blob key referenced by the project's assets: each asset's `blobKey`,
 * plus its `thumbnailKey` when present. Assets are project-global (shared across
 * every sequence), and an asset can sit in the bin with no clips referencing it,
 * so scanning `project.assets` is the whole reachable set. Clips carry only an
 * `assetId` and never a blob key of their own.
 */
/**
 * The media of `project` that no OTHER project still points at, so deleting the
 * project cannot take bytes another one needs.
 *
 * ⛔ "PER PROJECT COPIES" STOPPED BEING TRUE THE DAY THE AUTOMATIC RECOVERY
 * LANDED. `landRestored` gives a recovered project a fresh id and fresh sequence
 * ids and keeps its ASSETS exactly as they were, same asset ids and same
 * blobKeys. On 2026-08-22 that put six recovered projects on his shelf, several
 * of them the same edit of his at different times, every one pointing at one set
 * of bytes. Deleting any one row would have taken the media out from under his
 * real 44 clip edit, and the row he would most want gone is exactly the one
 * sharing with it.
 */
export function blobKeysOnlyUsedBy(project: Project, others: readonly Project[]): string[] {
  const shared = new Set<string>()
  for (const o of others) {
    if (!o || o.id === project.id) continue
    for (const key of reachableBlobKeys(o)) shared.add(key)
  }
  return [...reachableBlobKeys(project)].filter((k) => !shared.has(k))
}

export function reachableBlobKeys(project: Project): Set<string> {
  const keys = new Set<string>()
  for (const asset of Object.values(project.assets)) {
    keys.add(asset.blobKey)
    if (asset.thumbnailKey !== undefined) keys.add(asset.thumbnailKey)
  }
  return keys
}

/**
 * The stored keys that are safe to delete: project-owned media ('asset/' or
 * 'thumb/') that no asset in `project` still references. Everything else is kept
 * unconditionally: Library keys ('lib/', 'lib-thumb/') and any unrecognised
 * prefix are never orphans, which is the safety guarantee. Order and duplicates
 * of the input are preserved (deduping is the caller's business if it matters).
 */
export function orphanedBlobKeys(storedKeys: readonly string[], project: Project): string[] {
  const reachable = reachableBlobKeys(project)
  return storedKeys.filter((key) => isProjectMediaKey(key) && !reachable.has(key))
}
