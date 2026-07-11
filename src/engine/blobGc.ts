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
// Library, not any project — collecting them here would hole the Library. And an
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
 * so scanning `project.assets` is the whole reachable set — clips carry only an
 * `assetId` and never a blob key of their own.
 */
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
 * unconditionally — Library keys ('lib/', 'lib-thumb/') and any unrecognised
 * prefix are never orphans, which is the safety guarantee. Order and duplicates
 * of the input are preserved (deduping is the caller's business if it matters).
 */
export function orphanedBlobKeys(storedKeys: readonly string[], project: Project): string[] {
  const reachable = reachableBlobKeys(project)
  return storedKeys.filter((key) => isProjectMediaKey(key) && !reachable.has(key))
}
