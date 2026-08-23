import { Bookmark, Captions, Film, FolderOpen, Image as ImageIcon, Music, Plus, Sparkles, Upload, Volume2, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { filterEffects, matchesQuery } from '../engine/effects/search'
import { TRANSITION_KINDS, TRANSITION_LABELS } from '../engine/render/types'
import { SFX_LIBRARY, type SfxDef } from '../engine/sfx/sfx'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, type MediaAsset } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { createArmedDelete, type ArmedDelete } from './armedDelete'
import { CaptionsDialog } from './CaptionsDialog'
import { applyEffectToAllClips } from '../state/bulkEdits'
import { applyEffectToClips } from '../state/bulkEdits'
import { setClipTransition } from '../state/clipEdits'
import { openContextMenu, type MenuItem } from '../state/contextMenu'
import { ASSET_MIME, EFFECT_MIME, SFX_MIME, TRANSITION_MIME } from '../state/dnd'
import {
  addLibraryItemToProject,
  applyPresetToAllClips,
  applyPresetToSelection,
  isInLibrary,
  removeLibraryItem,
  removePreset,
  saveAssetToLibrary,
  useLibrary,
  type LibraryItem,
} from '../state/library'
import { healArrivedBlob, useMediaSync } from '../collab/mediaSync'
import { useCollab } from '../collab/collabControl'
import { deleteAsset, importFiles, insertAssetAtPlayhead, useImportProgress } from '../state/mediaActions'
import { importProjectFromFile, routeDroppedFiles } from '../state/projectFile'
import { matchFilesToMissing, missingMedia, relink, relinkSummary, type MissingAsset } from '../state/relinkMedia'
import { healProjectMedia } from '../state/mediaMirror'
import { evictAsset } from '../engine/frameCache'
import { invalidatePreview } from '../engine/preview'
import { useToasts } from '../state/toasts'
import { applyJettismLook, applyPunchyGradeToClips } from '../state/lookActions'
import { insertSfxAtPlayhead, previewSfx } from '../state/sfxActions'
import { useStore, type LeftTab } from '../state/store'
import { putBlob } from '../state/persistence'
import { Button } from '../ui/Button'

/**
 * Room media status: live transfers plus assets nobody in the room has bytes
 * for - each with a Locate button that heals the asset in place (same blob
 * key, so every clip using it lights up immediately and then uploads for the
 * rest of the room).
 */
function MediaSyncBanner() {
  const inRelayRoom = useCollab((s) => s.mode === 'relay')
  // Select the RAW arrays (stable identities) - deriving inside the selector
  // returns a new array per call and useSyncExternalStore loops forever on it.
  const rawTransfers = useMediaSync((s) => s.transfers)
  const missing = useMediaSync((s) => s.missing)
  const transfers = rawTransfers.map((t) => t.split('|')[1])
  const locateRef = useRef<HTMLInputElement>(null)
  const [locating, setLocating] = useState<{ blobKey: string; assetId: string } | null>(null)

  if (!inRelayRoom || (transfers.length === 0 && missing.length === 0)) return null
  return (
    <div
      data-testid="media-sync-banner"
      className="mx-2 mb-1 flex flex-col gap-1 rounded-overlay border border-border bg-bg-elevated px-2 py-1.5 text-[11px]"
    >
      {transfers.map((t) => (
        <div key={t} className="text-text-secondary">
          ⏳ {t}
        </div>
      ))}
      {missing.map((m) => (
        <div key={m.assetId} className="flex items-center justify-between gap-2">
          <span className="truncate text-text-secondary" title={m.name}>
            ⚠ {m.name}: no one in the room has this file
          </span>
          <button
            data-testid={`locate-${m.assetId}`}
            className="shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 text-accent hover:border-accent"
            onClick={() => {
              setLocating({ blobKey: m.blobKey, assetId: m.assetId })
              locateRef.current?.click()
            }}
          >
            Locate
          </button>
        </div>
      ))}
      <input
        ref={locateRef}
        type="file"
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (!file || !locating) return
          const { blobKey, assetId } = locating
          setLocating(null)
          void putBlob(blobKey, file).then(() => healArrivedBlob(blobKey, assetId))
        }}
      />
    </div>
  )
}

function Tab({ tab, label }: { tab: LeftTab; label: string }) {
  const active = useStore((s) => s.ui.leftTab === tab)
  const setUI = useStore((s) => s.setUI)
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setUI({ leftTab: tab })}
      className={`h-6 rounded-[4px] px-2.5 text-[12px] font-medium transition-colors duration-[120ms] ${
        active ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )
}

/** Window-level OS file drag: true while a Files drag hovers the app; drop anywhere imports. */
function useOsFileDrop(): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    // dragenter/dragleave fire per nested element, so track depth.
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth += 1
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      // A project file dropped on the window OPENS the project. It used to be
      // handed to the media importer, which called his own backup unsupported.
      const { project, ignored, media } = routeDroppedFiles(files)
      if (project) {
        if (ignored > 0) {
          useToasts
            .getState()
            .show(`Opening the project file. The other ${ignored} file(s) were not imported`, 'info')
        }
        void importProjectFromFile(project)
        return
      }
      void importFiles(media)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
  return dragging
}

const KIND_ICONS = { video: Film, audio: Music, image: ImageIcon } as const

/** Both halves of the action box: one shape, so neither can drift from the other. */
const ACTION_BUTTON =
  'min-w-0 flex-1 cursor-default truncate px-1 py-1 text-center text-[10px] transition-colors duration-[120ms] disabled:opacity-40'

/**
 * The permanent action box under every bin item. His call, 2026-08-09: "These
 * items on the left, I think they should all have a little box under them
 * permanently. I know this will make the space a little more cramped, but make
 * a box with two options: Save to library, Delete. Of course, the delete thing
 * you'd have to click twice."
 *
 * PERMANENT is the whole of it. No hover reveal, no selection gate, no density
 * setting: he weighed the cramping himself and chose it, so the cheapest way to
 * get this wrong is to "solve" a problem he already decided about.
 *
 * Both verbs already existed on this card's right-click menu, and this calls
 * the SAME two functions. It is a second surface for two actions, never a
 * second implementation of them, so the guards, the undo step and the toasts
 * stay in one place.
 *
 * The delete keeps the app's word for taking something out of a list, "Remove",
 * because the right-click menu on this very card says "Remove from bin" and the
 * toast says "Removed <name>". In this app Delete is what happens to clips on
 * the timeline. One word, one meaning.
 */
function AssetActions({ asset }: { asset: MediaAsset }) {
  const [armed, setArmed] = useState(false)
  // One holder for the life of the card: the timer must survive the re-renders
  // an import or an undo causes, without re-arming and without losing the
  // pending disarm.
  const armRef = useRef<ArmedDelete | null>(null)
  if (!armRef.current) armRef.current = createArmedDelete({ onChange: setArmed })
  const arm = armRef.current
  useEffect(() => () => arm.dispose(), [arm])

  // Name + duration is the Library's own identity for media (isInLibrary), so
  // the button can say "already there" up front instead of only on the click.
  const saved = useLibrary((s) => isInLibrary(s.items, asset.name, asset.durationS))

  return (
    <div
      data-testid="asset-actions"
      className="flex items-stretch border-t border-border"
      // The card around this is draggable and its double-click drops the asset
      // on the timeline. Neither belongs to the box: a second click HERE is the
      // delete confirmation, and a slip while pressing must not start a drag.
      // draggable makes this row the drag source, so cancelling it here cancels
      // the card's drag before it starts.
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Escape is the way out of an armed delete. Stopping it here also
          // keeps the global "Deselect all" off a keypress that meant this box.
          e.stopPropagation()
          arm.disarm()
        } else if (e.key === 'Enter') {
          // Enter already activates the focused button. The card's own Enter
          // would ALSO drop the asset at the playhead.
          e.stopPropagation()
        }
      }}
    >
      <button
        type="button"
        data-testid="asset-save-to-library"
        disabled={saved}
        aria-label={saved ? `${asset.name} is already in the Library` : `Save ${asset.name} to Library`}
        title={
          saved
            ? 'Already in the Library'
            : 'Save a copy to the Library, so it outlives this project'
        }
        onClick={() => void saveAssetToLibrary(asset.id)}
        className={`${ACTION_BUTTON} text-text-secondary hover:bg-bg-input hover:text-text-primary active:bg-border disabled:hover:bg-transparent disabled:hover:text-text-secondary`}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="asset-remove"
        data-armed={armed ? 'true' : undefined}
        aria-label={armed ? `Confirm removing ${asset.name} from the bin` : `Remove ${asset.name} from the bin`}
        title={
          armed
            ? 'Click again to remove it. It stops asking after a few seconds.'
            : 'Remove from the bin, and from every clip using it. Takes two clicks, and the toast can undo it.'
        }
        onClick={() => {
          if (arm.press() === 'confirmed') deleteAsset(asset.id)
        }}
        // An armed delete must never sit waiting on screen for a click that was
        // aimed at something else. Leaving the button takes the safety back on,
        // as does the timer inside press().
        onBlur={() => arm.disarm()}
        className={`${ACTION_BUTTON} border-l border-border ${
          armed
            ? 'bg-danger/20 font-medium text-danger hover:bg-danger/30 active:bg-danger/40'
            : 'text-text-secondary hover:bg-danger/15 hover:text-danger active:bg-danger/25'
        }`}
      >
        {armed ? 'Confirm' : 'Remove'}
      </button>
    </div>
  )
}

function AssetCard({ asset, fps }: { asset: MediaAsset; fps: number }) {
  const thumbUrl = useBlobUrl(asset.thumbnailKey)
  const Icon = KIND_ICONS[asset.kind]
  return (
    <div
      data-testid="asset-card"
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={(e) => {
        // Inserting moves the user's working context to the TIMELINE - drop the
        // card's focus so a follow-up Delete edits the timeline selection, not
        // the bin (a focused card would otherwise swallow it and nuke the asset).
        e.currentTarget.blur()
        insertAssetAtPlayhead(asset.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') insertAssetAtPlayhead(asset.id)
        // A SINGLE click focuses the card (tabIndex) - that is the bin
        // selection, so Delete removes this asset. stopPropagation keeps the
        // global keymap from ALSO deleting the timeline selection.
        else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.stopPropagation()
          deleteAsset(asset.id)
        }
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add to timeline', shortcut: 'Enter', onClick: () => insertAssetAtPlayhead(asset.id) },
          { label: 'Save to Library', onClick: () => void saveAssetToLibrary(asset.id) },
          {
            // "Remove from …" is the one shape for taking things out of any
            // list (bin / Library / presets); "Delete" stays for timeline clips.
            label: 'Remove from bin',
            shortcut: 'Del',
            danger: true,
            separator: true,
            onClick: () => deleteAsset(asset.id),
          },
        ])
      }
      className="cursor-default overflow-hidden rounded-overlay border border-border bg-bg-elevated transition-colors duration-[120ms] ease-out hover:border-border-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
    >
      <div className="relative flex aspect-video items-center justify-center bg-black">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <Icon size={16} strokeWidth={1.5} className="text-text-muted" aria-hidden />
        )}
        {asset.kind !== 'image' && (
          <span className="absolute right-1 bottom-1 rounded-[3px] bg-black/70 px-1 text-[10px] text-text-primary tabular-nums">
            {formatTimecode(asset.durationS, fps)}
          </span>
        )}
      </div>
      <div title={asset.name} className="truncate px-1.5 py-1 text-[11px] text-text-secondary">
        {asset.name}
      </div>
      <AssetActions asset={asset} />
    </div>
  )
}

/**
 * What the app is doing while it copies a drop in. Without this the panel sat on
 * "Import media to begin" for the whole copy, which on a multi-GB capture looks
 * exactly like a crash, so the file gets dropped a second time.
 */
function ImportProgress() {
  const total = useImportProgress((s) => s.total)
  const done = useImportProgress((s) => s.done)
  const name = useImportProgress((s) => s.name)
  if (total === 0) return null
  return (
    <div
      data-testid="import-progress"
      className="mx-2 mb-1 flex items-center gap-2 rounded-overlay border border-border bg-bg-elevated px-2 py-1.5 text-[11px]"
    >
      <span className="shrink-0 tabular-nums text-text-secondary">
        {total > 1 ? `Importing ${done + 1} of ${total}` : 'Importing'}
      </span>
      <span className="truncate text-text-muted" title={name}>
        {name}
      </span>
    </div>
  )
}

/**
 * The way back when a project's media has lost its bytes.
 *
 * ⛔ HIS WORDS, 2026-08-23: *"The recovered file doesn't even fucking work. The
 * audio is not there, and the video isn't."* Until now the app named the files
 * and left it there, and importing them again would have made NEW assets, so
 * every one of his forty four cuts would still point at nothing. This puts the
 * bytes back under the key the edit already uses.
 *
 * It only appears when something really is missing, checked against storage
 * rather than against a flag, so a healthy project never sees it.
 */
function FindMyMedia() {
  const assets = useStore((s) => s.project.assets)
  const [missing, setMissing] = useState<MissingAsset[]>([])
  const [busy, setBusy] = useState(false)
  const pick = useRef<HTMLInputElement>(null)

  const [why, setWhy] = useState('')

  useEffect(() => {
    let live = true
    void (async () => {
      const found = await missingMedia(useStore.getState().project)
      if (!live || found.length === 0) {
        if (live) setMissing([])
        return
      }
      // ⛔ TRY THE SPARE COPIES BEFORE ASKING HIM FOR ANYTHING. The same repair
      // runs at boot, and on 2026-08-23 it did not fire for him: he opened v2.27
      // and got this banner instead of his edit. This is a SECOND, independent
      // trigger, from a place that provably runs, because it only exists once the
      // panel has mounted and the project is loaded. Whatever went wrong at boot,
      // it does not get a second chance to cost him the day.
      const healed = await healProjectMedia(useStore.getState().project)
      if (!live) return
      if (healed.healed.length > 0) {
        useToasts
          .getState()
          .show(
            `Put ${healed.healed.length} media ${healed.healed.length === 1 ? 'file' : 'files'} back on your edit`,
            'success',
            undefined,
            { durationMs: 10_000 },
          )
        for (const a of Object.values(useStore.getState().project.assets)) evictAsset(a.id)
        invalidatePreview()
      }
      // ⛔ AND IF IT COULD NOT, SAY WHY ON THE BANNER. A banner that only says
      // "no media" with no reason is what he read as "you did nothing".
      setWhy(healed.failure ?? '')
      setMissing(await missingMedia(useStore.getState().project))
    })()
    return () => {
      live = false
    }
  }, [assets])

  if (missing.length === 0) return null
  return (
    <div
      data-testid="find-my-media"
      className="mx-2 mb-2 rounded-field border border-warning/40 bg-warning/10 px-2 py-2 text-[11px] text-text-primary"
    >
      <div className="mb-1.5">
        {missing.length} {missing.length === 1 ? 'file' : 'files'} on this edit have no media. Your cuts are all still
        here.
        {why !== '' && <span className="mt-1 block text-text-muted">The spare copies could not be used: {why}</span>}
      </div>
      <Button
        variant="secondary"
        data-testid="find-my-media-go"
        disabled={busy}
        onClick={() => pick.current?.click()}
      >
        {busy ? 'Putting them back' : 'Find my media'}
      </Button>
      <input
        ref={pick}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        data-testid="find-my-media-input"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          if (files.length === 0) return
          setBusy(true)
          void (async () => {
            const result = matchFilesToMissing(missing, files)
            const { done, failed } = await relink(result.matched)
            useToasts.getState().show(relinkSummary(result, done), done > 0 ? 'success' : 'info')
            if (failed.length > 0) useToasts.getState().show(`Could not write: ${failed.join(', ')}`, 'danger')
            // Ask storage again rather than assuming, and make the preview drop
            // whatever it decided when the bytes were not there.
            for (const m of result.matched) evictAsset(m.asset.id)
            invalidatePreview()
            setMissing(await missingMedia(useStore.getState().project))
            setBusy(false)
          })()
        }}
      />
    </div>
  )
}

function MediaTab() {
  const assets = useStore((s) => s.project.assets)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const fileInput = useRef<HTMLInputElement>(null)
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const importing = useImportProgress((s) => s.total)
  // Newest import first, so the file you just added is at the top (matches the
  // Library and every other panel) instead of buried at the bottom of the grid.
  const list = Object.values(assets).reverse()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          <Plus size={16} strokeWidth={1.5} />
          Import
        </Button>
        <Button variant="secondary" data-testid="open-captions" onClick={() => setCaptionsOpen(true)}>
          <Captions size={16} strokeWidth={1.5} />
          Captions
        </Button>
        {captionsOpen && <CaptionsDialog onClose={() => setCaptionsOpen(false)} />}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          data-testid="media-file-input"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? [])
            // Reset so picking the same file again re-fires change.
            e.currentTarget.value = ''
            if (files.length > 0) void importFiles(files)
          }}
        />
      </div>
      <FindMyMedia />
      <MediaSyncBanner />
      <ImportProgress />
      {list.length === 0 && importing === 0 ? (
        <div
          data-testid="media-empty"
          onDragOver={(e) => e.preventDefault()}
          className="m-2 mt-0 flex flex-1 flex-col items-center justify-center gap-2 rounded-overlay border border-dashed border-border-strong text-center"
        >
          <FolderOpen size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[13px] text-text-secondary">Import media to begin</div>
          <div className="text-[11px] text-text-muted">Drop files here or click + Import</div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-2 pt-0">
          {list.map((a) => (
            <AssetCard key={a.id} asset={a} fps={fps} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One draggable entry. `onApply` (optional) makes double-click/Enter apply it
 * to the selected clip; `menu` adds a right-click menu (an effect can go on
 * every clip at once from there, with no selection at all). Transitions have
 * no `onApply` - their edge choice IS the drop position, so a click apply
 * would have to pick an edge silently; their menu names each edge instead.
 */
function BrowserItem({
  name,
  title,
  mime,
  payload,
  onApply,
  testId,
  menu,
}: {
  name: string
  title: string
  mime: string
  payload: string
  onApply?: () => void
  testId: string
  menu?: MenuItem[]
}) {
  return (
    <div
      data-testid={testId}
      data-payload={payload}
      role="button"
      tabIndex={0}
      draggable
      title={title}
      onDragStart={(e) => {
        e.dataTransfer.setData(mime, payload)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={onApply}
      onContextMenu={menu ? (e) => openContextMenu(e, menu) : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onApply?.()
      }}
      className="flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
    >
      <Sparkles size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
      <span className="truncate">{name}</span>
    </div>
  )
}


function EffectsTab() {
  const [query, setQuery] = useState('')
  const selection = useStore((s) => s.ui.selection)
  // Effects + grades apply to the WHOLE selection through the bulk helpers
  // (one undo step). Selecting five clips used to grey the browser out entirely.
  const targets = selection
  const hasTarget = targets.length > 0
  const applyLabel = targets.length > 1 ? `Apply to ${targets.length} clips` : 'Apply to selected clip'

  // ONE filter, shared with the inspector's Add effect box (effects/search.ts),
  // so the two surfaces cannot answer the same search differently. It reads the
  // DESCRIPTION as well now, which is how "grain" reaches Noise and "vignette"
  // reaches the effect that darkens toward the edges.
  const effects = filterEffects(query)
  const transitions = TRANSITION_KINDS.filter((k) => matchesQuery(query, TRANSITION_LABELS[k], k))
  const showLook = matchesQuery(query, 'Jettism', 'look')
  // The Motion tiles were removed in the 2026-07-18 de-bloat: punch-in/impact/
  // whip live on the clip right-click Motion submenu, the P key, and (with a
  // depth control) the Inspector's PunchControl - this was a fourth, least
  // capable surface for the same verbs.
  const empty = effects.length === 0 && transitions.length === 0 && !showLook

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search effects"
          aria-label="Search effects and transitions"
          data-testid="effect-search"
          className="h-7 w-full rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {!hasTarget && (
          <p className="px-2 pb-1.5 text-[10px] text-text-muted">
            Select a clip to apply, drag straight onto one, or right-click to apply to every clip, or a transition to either edge.
          </p>
        )}

        {empty ? (
          <div className="px-2 py-6 text-center text-[11px] text-text-muted">No match for &ldquo;{query}&rdquo;</div>
        ) : (
          <>
            {showLook && (
              <section className="mb-2">
                <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                  Looks
                </h3>
                <div
                  data-testid="look-jettism"
                  role="button"
                  tabIndex={0}
                  title="One click: 9:16, punchy grade on every clip, pop-in titles. Grade lands in the Library as 'Jettism Punch'."
                  onDoubleClick={applyJettismLook}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyJettismLook()
                  }}
                  className="flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
                >
                  <Wand2 size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
                  <span className="truncate">Jettism (Shorts template)</span>
                </div>
                <div
                  data-testid="look-grade"
                  role="button"
                  tabIndex={0}
                  title="Just the punch grade (+exposure/+contrast/+saturation) on the selected clip"
                  onDoubleClick={() => applyPunchyGradeToClips(targets)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyPunchyGradeToClips(targets)
                  }}
                  className="flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
                >
                  <Wand2 size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
                  <span className="truncate">Punchy Grade (selected clip)</span>
                </div>
              </section>
            )}
            {effects.length > 0 && (
              <section className="mb-2">
                <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                  Effects
                </h3>
                {effects.map((e) => (
                  <BrowserItem
                    key={e.type}
                    testId="effect-item"
                    name={e.label}
                    title={e.description}
                    mime={EFFECT_MIME}
                    payload={e.type}
                    onApply={() => applyEffectToClips(targets, e.type)}
                    menu={[
                      {
                        label: applyLabel,
                        shortcut: 'Enter',
                        onClick: () => applyEffectToClips(targets, e.type),
                      },
                      { label: 'Apply to every clip', onClick: () => applyEffectToAllClips(e.type) },
                    ]}
                  />
                ))}
              </section>
            )}

            {transitions.length > 0 && (
              <section>
                <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                  Transitions
                </h3>
                {/* No double-click apply, deliberately: the old one silently
                    targeted the IN edge with no way to know or choose. Every
                    apply path names its edge - the drag by drop position
                    (half-clip highlight), the right-click menu and the
                    Inspector's Transitions section by explicit label. */}
                {transitions.map((k) => (
                  <BrowserItem
                    key={k}
                    testId="transition-item"
                    name={TRANSITION_LABELS[k]}
                    title="Drag onto a clip (left half = start, right half = end), or right-click to apply to the selected clip's start or end"
                    mime={TRANSITION_MIME}
                    payload={k}
                    menu={[
                      {
                        label: 'Apply to clip start',
                        disabled: !hasTarget,
                        onClick: () => hasTarget && setClipTransition(targets[0], 'in', k),
                      },
                      {
                        label: 'Apply to clip end',
                        disabled: !hasTarget,
                        onClick: () => hasTarget && setClipTransition(targets[0], 'out', k),
                      },
                    ]}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** One saved media entry. Double-click brings it into the current project. */
function LibraryCard({ item, fps }: { item: LibraryItem; fps: number }) {
  const thumbUrl = useBlobUrl(item.thumbnailKey)
  const Icon = KIND_ICONS[item.kind]
  return (
    <div
      data-testid="library-card"
      role="button"
      tabIndex={0}
      onDoubleClick={() => void addLibraryItemToProject(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void addLibraryItemToProject(item.id)
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add to project', shortcut: 'Enter', onClick: () => void addLibraryItemToProject(item.id) },
          {
            label: 'Remove from Library',
            danger: true,
            separator: true,
            onClick: () => void removeLibraryItem(item.id),
          },
        ])
      }
      className="cursor-default overflow-hidden rounded-overlay border border-border bg-bg-elevated transition-colors duration-[120ms] ease-out hover:border-border-strong"
    >
      <div className="relative flex aspect-video items-center justify-center bg-black">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <Icon size={16} strokeWidth={1.5} className="text-text-muted" aria-hidden />
        )}
        {item.kind !== 'image' && (
          <span className="absolute right-1 bottom-1 rounded-[3px] bg-black/70 px-1 text-[10px] text-text-primary tabular-nums">
            {formatTimecode(item.durationS, fps)}
          </span>
        )}
      </div>
      <div title={item.name} className="truncate px-1.5 py-1 text-[11px] text-text-secondary">
        {item.name}
      </div>
    </div>
  )
}

/** One bundled stinger: click auditions it, double-click drops it at the playhead. */
function SfxRow({ sfx }: { sfx: SfxDef }) {
  return (
    <div
      data-testid="sfx-item"
      data-payload={sfx.id}
      role="button"
      tabIndex={0}
      draggable
      title="Click to preview · double-click or drag to add"
      onDragStart={(e) => {
        e.dataTransfer.setData(SFX_MIME, sfx.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => previewSfx(sfx.id)}
      onDoubleClick={() => void insertSfxAtPlayhead(sfx.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void insertSfxAtPlayhead(sfx.id)
      }}
      className="flex cursor-grab items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary active:cursor-grabbing"
    >
      <Volume2 size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
      <span className="truncate">{sfx.name}</span>
      <span className="ml-auto shrink-0 text-[10px] text-text-muted tabular-nums">{sfx.durationS.toFixed(1)}s</span>
    </div>
  )
}

function LibraryTab() {
  const items = useLibrary((s) => s.items)
  const presets = useLibrary((s) => s.presets)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const hasSelection = useStore((s) => s.ui.selection.length === 1)
  const empty = items.length === 0 && presets.length === 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {/* Not an EMPTY state: the bundled sound effects below always fill this
          tab, so a "Nothing saved yet" card sat on screen directly above a list
          of eight SFX and read as a bug. What is actually empty is the user's
          own saved media + presets, so say only that, in one line. */}
      {empty && (
        <div data-testid="library-empty" className="mb-3 px-0.5 text-[11px] leading-relaxed text-text-muted">
          Nothing of your own saved yet. Use Save under any media item, or save a graded clip’s
          effects as a preset.
        </div>
      )}
      {items.length > 0 && (
        <section className="mb-3">
          <h3 className="px-0.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            Media
          </h3>
          <div className="grid grid-cols-2 content-start gap-2">
            {items.map((item) => (
              <LibraryCard key={item.id} item={item} fps={fps} />
            ))}
          </div>
        </section>
      )}
      {presets.length > 0 && (
        <section>
          <h3 className="px-0.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            Effect presets
          </h3>
          {!hasSelection && (
            <p className="px-0.5 pb-1 text-[10px] text-text-muted">
              Select a clip to apply one, or right-click → Apply to every clip.
            </p>
          )}
          {presets.map((p) => (
            <div
              key={p.id}
              data-testid="preset-item"
              role="button"
              tabIndex={0}
              title={`${p.effects.length} effect(s); double-click to apply to the selected clip`}
              onDoubleClick={() => applyPresetToSelection(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPresetToSelection(p.id)
              }}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: 'Apply to selected clip', shortcut: 'Enter', onClick: () => applyPresetToSelection(p.id) },
                  { label: 'Apply to every clip', onClick: () => applyPresetToAllClips(p.id) },
                  { label: 'Remove preset', danger: true, separator: true, onClick: () => void removePreset(p.id) },
                ])
              }
              className={`flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors duration-[120ms] ${
                hasSelection ? 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary' : 'text-text-muted'
              }`}
            >
              <Bookmark size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-text-muted">{p.effects.length} fx</span>
            </div>
          ))}
        </section>
      )}
      <section className={items.length > 0 || presets.length > 0 ? 'mt-3' : ''}>
        <h3 className="px-0.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          Sound effects
        </h3>
        <p className="px-0.5 pb-1 text-[10px] text-text-muted">
          Click to preview · double-click to drop at the playhead.
        </p>
        {SFX_LIBRARY.map((sfx) => (
          <SfxRow key={sfx.id} sfx={sfx} />
        ))}
      </section>
    </div>
  )
}

export function LeftPanel({ width }: { width: number }) {
  const leftTab = useStore((s) => s.ui.leftTab)
  const dragging = useOsFileDrop()
  return (
    <aside
      data-testid="panel-left"
      className="flex min-h-0 shrink-0 flex-col bg-bg-panel"
      style={{ width }}
    >
      <div role="tablist" className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Tab tab="media" label="Media" />
        <Tab tab="effects" label="Effects" />
        <Tab tab="library" label="Library" />
      </div>
      {/* key on the tab so the content fades in on each switch (hard cut → soft). */}
      <div key={leftTab} className="flex min-h-0 flex-1 animate-[fade-in_100ms_ease-out] flex-col">
        {leftTab === 'media' ? <MediaTab /> : leftTab === 'effects' ? <EffectsTab /> : <LibraryTab />}
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex bg-black/60 p-4">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-overlay border-2 border-dashed border-accent bg-accent-quiet">
            <Upload size={24} strokeWidth={1.5} className="text-accent" aria-hidden />
            <div className="text-[14px] font-medium text-text-primary">Drop to import</div>
          </div>
        </div>
      )}
    </aside>
  )
}
