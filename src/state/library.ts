// The global Library: media and effect presets that OUTLIVE any project.
//
// Ownership model is copy-on-save and copy-on-use. Saving an asset to the
// Library copies its blob under a 'lib/' key; using a library item in a project
// copies it back under a fresh 'asset/' key. Bytes are duplicated, but neither
// side can ever break the other: deleting a bin asset cannot hole the Library,
// and removing a Library item cannot hole a project that used it. For the small
// evergreen media a library holds (intros, watermarks, jingles) that trade is
// obviously right.
//
// Library operations are global, so they are NOT on the project undo stack.
// Destructive ones (remove) only ever delete the Library's own copy.

import { autoPresetName, copyEffects, presetFromClip, type EffectPreset } from '../engine/effects/presets'
import { activeSequence, newId, type Id, type MediaAsset } from '../engine/types'
import { create } from 'zustand'
import { db, getBlob, putBlob } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

export interface LibraryItem {
  id: Id
  name: string
  kind: MediaAsset['kind']
  /** 'lib/<id>': the Library's OWN copy of the media. */
  blobKey: string
  thumbnailKey?: string
  durationS: number
  width?: number
  height?: number
  hasAudio: boolean
  hasVideo: boolean
  addedAt: number
}

interface LibraryState {
  items: LibraryItem[]
  presets: EffectPreset[]
  loaded: boolean
}

export const useLibrary = create<LibraryState>(() => ({ items: [], presets: [], loaded: false }))

const byNewest = <T extends { addedAt?: number; createdAt?: number }>(a: T, b: T): number =>
  (b.addedAt ?? b.createdAt ?? 0) - (a.addedAt ?? a.createdAt ?? 0)

/** Load once at boot. Safe to call again (idempotent refresh). */
export async function loadLibrary(): Promise<void> {
  const d = await db()
  const [items, presets] = await Promise.all([d.getAll('library'), d.getAll('presets')])
  useLibrary.setState({
    items: (items as LibraryItem[]).sort(byNewest),
    presets: (presets as EffectPreset[]).sort(byNewest),
    loaded: true,
  })
}

// ---------------------------------------------------------------------------
// Media

/**
 * Is this media already in the Library? Name plus duration IS the Library's
 * identity for a piece of media: the bytes are copied on save, so blob keys
 * never match, and re-importing the same file gives it a fresh asset id.
 *
 * Exported so the bin's permanent Save button can show the answer BEFORE the
 * click instead of re-deriving the rule and drifting from the one below.
 */
export function isInLibrary(items: readonly LibraryItem[], name: string, durationS: number): boolean {
  return items.some((i) => i.name === name && i.durationS === durationS)
}

/** Save a bin asset to the Library (copy-on-save). */
export async function saveAssetToLibrary(assetId: Id): Promise<void> {
  const show = useToasts.getState().show
  const asset = useStore.getState().project.assets[assetId]
  if (!asset) return
  if (isInLibrary(useLibrary.getState().items, asset.name, asset.durationS)) {
    show(`${asset.name} is already in the Library`)
    return
  }
  const blob = await getBlob(asset.blobKey)
  if (!blob) {
    show(`${asset.name}: media is missing from local storage`, 'danger')
    return
  }
  const id = newId()
  const item: LibraryItem = {
    id,
    name: asset.name,
    kind: asset.kind,
    blobKey: `lib/${id}`,
    durationS: asset.durationS,
    ...(asset.width !== undefined ? { width: asset.width } : {}),
    ...(asset.height !== undefined ? { height: asset.height } : {}),
    hasAudio: asset.hasAudio,
    hasVideo: asset.hasVideo,
    addedAt: Date.now(),
  }
  await putBlob(item.blobKey, blob)
  if (asset.thumbnailKey) {
    const thumb = await getBlob(asset.thumbnailKey)
    if (thumb) {
      item.thumbnailKey = `lib-thumb/${id}`
      await putBlob(item.thumbnailKey, thumb)
    }
  }
  const d = await db()
  await d.put('library', item, id)
  useLibrary.setState((s) => ({ items: [item, ...s.items] }))
  show(`Saved ${asset.name} to Library`, 'success')
}

/** Bring a Library item into the current project's bin (copy-on-use). */
export async function addLibraryItemToProject(itemId: Id): Promise<void> {
  const show = useToasts.getState().show
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const blob = await getBlob(item.blobKey)
  if (!blob) {
    show(`${item.name}: Library media is missing`, 'danger')
    return
  }
  const id = newId()
  const blobKey = `asset/${id}`
  await putBlob(blobKey, blob)
  const asset: MediaAsset = {
    id,
    name: item.name,
    kind: item.kind,
    blobKey,
    durationS: item.durationS,
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    hasAudio: item.hasAudio,
    hasVideo: item.hasVideo,
    codec: undefined,
  }
  if (item.thumbnailKey) {
    const thumb = await getBlob(item.thumbnailKey)
    if (thumb) {
      asset.thumbnailKey = `thumb/${id}`
      await putBlob(asset.thumbnailKey, thumb)
    }
  }
  useStore.getState().dispatch(`Add ${item.name} from Library`, (p) => ({
    ...p,
    assets: { ...p.assets, [id]: asset },
  }))
  show(`Added ${item.name} to the project`, 'success')
}

/** Remove a Library item and ITS OWN blobs. Projects that used it keep their copies. */
export async function removeLibraryItem(itemId: Id): Promise<void> {
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const d = await db()
  await d.delete('library', itemId)
  await d.delete('blobs', item.blobKey)
  if (item.thumbnailKey) await d.delete('blobs', item.thumbnailKey)
  useLibrary.setState((s) => ({ items: s.items.filter((i) => i.id !== itemId) }))
  useToasts.getState().show(`Removed ${item.name} from Library`)
}

// ---------------------------------------------------------------------------
// Effect presets

/** Save the selected clip's effect stack as a preset. */
export async function saveSelectionAsPreset(): Promise<void> {
  const show = useToasts.getState().show
  const { project, ui } = useStore.getState()
  const clipId = ui.selection[0]
  const clip = clipId
    ? activeSequence(project)
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === clipId)
    : undefined
  if (!clip) return
  const preset = presetFromClip(clip, newId(), Date.now(), newId)
  if (!preset) {
    show('This clip has no effects to save')
    return
  }
  const d = await db()
  await d.put('presets', preset, preset.id)
  useLibrary.setState((s) => ({ presets: [preset, ...s.presets] }))
  show(`Saved preset "${preset.name}"`, 'success')
}

/** Apply a preset to the selected clip as ONE undo step on the project stack. */
export function applyPresetToSelection(presetId: Id): void {
  const show = useToasts.getState().show
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  const { ui, dispatch } = useStore.getState()
  const clipId = ui.selection[0]
  if (!preset || !clipId) {
    if (!clipId) show('Select a clip first')
    return
  }
  // ⛔ A LOCKED TRACK IS REFUSED, like everywhere else in the app. Clicking a
  // clip on a locked track still selects it, on purpose, so the selection this
  // runs on can easily be one: the preset landed on the very clips he locked the
  // track to protect, and said "Applied" as if nothing were unusual.
  const lockedOut = activeSequence(useStore.getState().project).tracks.some(
    (t) => t.locked && t.clips.some((c) => c.id === clipId),
  )
  if (lockedOut) {
    show('That clip is on a locked track', 'danger')
    return
  }
  dispatch(`Apply preset ${preset.name}`, (p) => {
    const seq = activeSequence(p)
    const tracks = seq.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? {
            ...t,
            clips: t.clips.map((c) =>
              // Append with fresh ids (copyEffects), never replace: a preset is
              // "add my look", and clobbering an existing grade would surprise.
              c.id === clipId ? { ...c, effects: [...c.effects, ...copyEffects(preset.effects, newId)] } : c,
            ),
          }
        : t,
    )
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
  })
  show(`Applied "${preset.name}"`, 'success')
}

/**
 * Apply a preset to EVERY video clip in the active sequence, in ONE undo step.
 * Audio clips are skipped (visual effects don't apply to them). Each clip gets
 * its OWN fresh-id copy of the effects, appended (never replacing an existing
 * grade), exactly like applyPresetToSelection.
 */
export function applyPresetToAllClips(presetId: Id): void {
  const show = useToasts.getState().show
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  const { project, dispatch } = useStore.getState()
  if (!preset) return
  // Locked tracks are neither changed nor COUNTED. Counting them made the toast
  // over-report by however many clips he had protected.
  const targetCount = activeSequence(project)
    .tracks.filter((t) => t.kind === 'video' && !t.locked)
    .reduce((n, t) => n + t.clips.length, 0)
  if (targetCount === 0) {
    show('No video clips to apply the preset to')
    return
  }
  dispatch(`Apply preset ${preset.name} to all clips`, (p) => {
    const seq = activeSequence(p)
    const tracks = seq.tracks.map((t) =>
      t.kind !== 'video' || t.locked
        ? t
        : {
            ...t,
            clips: t.clips.map((c) => ({
              ...c,
              effects: [...c.effects, ...copyEffects(preset.effects, newId)],
            })),
          },
    )
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
  })
  show(`Applied "${preset.name}" to ${targetCount} clip${targetCount === 1 ? '' : 's'}`, 'success')
}

export async function removePreset(presetId: Id): Promise<void> {
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  if (!preset) return
  const d = await db()
  await d.delete('presets', presetId)
  useLibrary.setState((s) => ({ presets: s.presets.filter((p) => p.id !== presetId) }))
  useToasts.getState().show(`Removed preset "${preset.name}"`)
}

export { autoPresetName }
