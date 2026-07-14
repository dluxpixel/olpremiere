import { Bookmark, Captions, Film, FolderOpen, Image as ImageIcon, Music, Plus, Sparkles, Type, Upload, Volume2, Wand2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { EFFECTS } from '../engine/effects/registry'
import { TRANSITION_KINDS, type TransitionKind } from '../engine/render/types'
import { SFX_LIBRARY, type SfxDef } from '../engine/sfx/sfx'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, type MediaAsset } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { CaptionsDialog } from './CaptionsDialog'
import { applyEffect, setClipTransition } from '../state/clipEdits'
import { openContextMenu } from '../state/contextMenu'
import { ASSET_MIME, EFFECT_MIME, TRANSITION_MIME } from '../state/dnd'
import {
  addLibraryItemToProject,
  applyPresetToAllClips,
  applyPresetToSelection,
  removeLibraryItem,
  removePreset,
  saveAssetToLibrary,
  useLibrary,
  type LibraryItem,
} from '../state/library'
import { healArrivedBlob, useMediaSync } from '../collab/mediaSync'
import { useCollab } from '../collab/collabControl'
import { deleteAsset, importFiles, insertAssetAtPlayhead } from '../state/mediaActions'
import { applyJettismLook, applyPunchyGrade } from '../state/lookActions'
import { impactAtPlayhead, punchInAtPlayhead, whipToNext } from '../state/motionActions'
import { insertSfxAtPlayhead, previewSfx } from '../state/sfxActions'
import { useStore, type LeftTab } from '../state/store'
import { addTitleClip } from '../state/titleActions'
import { putBlob } from '../state/persistence'
import { Button } from '../ui/Button'

/**
 * Room media status: live transfers plus assets nobody in the room has bytes
 * for — each with a Locate button that heals the asset in place (same blob
 * key, so every clip using it lights up immediately and then uploads for the
 * rest of the room).
 */
function MediaSyncBanner() {
  const inRelayRoom = useCollab((s) => s.mode === 'relay')
  // Select the RAW arrays (stable identities) — deriving inside the selector
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
      className="mx-2 mb-1 flex flex-col gap-1 rounded-[6px] border border-border bg-bg-elevated px-2 py-1.5 text-[11px]"
    >
      {transfers.map((t) => (
        <div key={t} className="text-text-secondary">
          ⏳ {t}
        </div>
      ))}
      {missing.map((m) => (
        <div key={m.assetId} className="flex items-center justify-between gap-2">
          <span className="truncate text-text-secondary" title={m.name}>
            ⚠ {m.name} — no one in the room has this file
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
      if (files.length > 0) void importFiles(files)
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
        // Inserting moves the user's working context to the TIMELINE — drop the
        // card's focus so a follow-up Delete edits the timeline selection, not
        // the bin (a focused card would otherwise swallow it and nuke the asset).
        e.currentTarget.blur()
        insertAssetAtPlayhead(asset.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') insertAssetAtPlayhead(asset.id)
        // A SINGLE click focuses the card (tabIndex) — that is the bin
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
            label: 'Delete from bin',
            shortcut: 'Del',
            danger: true,
            separator: true,
            onClick: () => deleteAsset(asset.id),
          },
        ])
      }
      className="cursor-default overflow-hidden rounded-[6px] border border-border bg-bg-elevated transition-colors duration-[120ms] ease-out hover:border-border-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
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
    </div>
  )
}

function MediaTab() {
  const assets = useStore((s) => s.project.assets)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const fileInput = useRef<HTMLInputElement>(null)
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const list = Object.values(assets)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          <Plus size={16} strokeWidth={1.5} />
          Import
        </Button>
        <Button variant="secondary" data-testid="add-text" onClick={() => addTitleClip()}>
          <Type size={16} strokeWidth={1.5} />
          Text
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
      <MediaSyncBanner />
      {list.length === 0 ? (
        <div
          data-testid="media-empty"
          onDragOver={(e) => e.preventDefault()}
          className="m-2 mt-0 flex flex-1 flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border-strong text-center"
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

/** One draggable entry. Double-click applies it to the selected clip. */
function BrowserItem({
  name,
  title,
  mime,
  payload,
  onApply,
  disabled,
  testId,
}: {
  name: string
  title: string
  mime: string
  payload: string
  onApply: () => void
  disabled: boolean
  testId: string
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
      onKeyDown={(e) => {
        if (e.key === 'Enter') onApply()
      }}
      className={`flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors duration-[120ms] ${
        disabled
          ? 'text-text-muted'
          : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
      }`}
    >
      <Sparkles size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
      <span className="truncate">{name}</span>
    </div>
  )
}

const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossDissolve: 'Cross Dissolve',
  dipToBlack: 'Dip to Black',
  dipToWhite: 'Dip to White',
  wipeLeft: 'Wipe Left',
  wipeRight: 'Wipe Right',
  slideLeft: 'Slide Left',
  slideRight: 'Slide Right',
}

function EffectsTab() {
  const [query, setQuery] = useState('')
  const selection = useStore((s) => s.ui.selection)
  const targetId = selection.length === 1 ? selection[0] : undefined

  const q = query.trim().toLowerCase()
  const matches = (s: string): boolean => q === '' || s.toLowerCase().includes(q)

  const effects = EFFECTS.filter((e) => matches(e.label) || matches(e.type))
  const transitions = TRANSITION_KINDS.filter((k) => matches(TRANSITION_LABELS[k]) || matches(k))
  const showLook = matches('Jettism') || matches('look')
  const motion = [
    { key: 'punch', name: 'Punch in (at playhead)', run: punchInAtPlayhead },
    { key: 'impact', name: 'Impact hit (at playhead)', run: impactAtPlayhead },
    { key: 'whip', name: 'Whip to next clip', run: whipToNext },
  ].filter((m) => matches(m.name) || matches('motion'))
  const empty = effects.length === 0 && transitions.length === 0 && !showLook && motion.length === 0

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
          className="h-7 w-full rounded-[4px] bg-bg-input px-2 text-[12px] text-text-primary placeholder:text-text-muted"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {!targetId && (
          <p className="px-2 pb-1.5 text-[10px] text-text-muted">
            Select a clip to apply, or drag straight onto one.
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
                  onDoubleClick={() => targetId && applyPunchyGrade(targetId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && targetId) applyPunchyGrade(targetId)
                  }}
                  className={`flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors duration-[120ms] ${
                    targetId ? 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary' : 'text-text-muted'
                  }`}
                >
                  <Wand2 size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
                  <span className="truncate">Punchy Grade (selected clip)</span>
                </div>
              </section>
            )}
            {motion.length > 0 && (
              <section className="mb-2">
                <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                  Motion
                </h3>
                {motion.map((m) => (
                  <div
                    key={m.key}
                    data-testid={`motion-${m.key}`}
                    role="button"
                    tabIndex={0}
                    title="Double-click to apply to the selected clip"
                    onDoubleClick={() => targetId && m.run(targetId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && targetId) m.run(targetId)
                    }}
                    className={`flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors duration-[120ms] ${
                      targetId ? 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary' : 'text-text-muted'
                    }`}
                  >
                    <Zap size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-text-muted" />
                    <span className="truncate">{m.name}</span>
                  </div>
                ))}
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
                    disabled={!targetId}
                    onApply={() => targetId && applyEffect(targetId, e.type)}
                  />
                ))}
              </section>
            )}

            {transitions.length > 0 && (
              <section>
                <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                  Transitions
                </h3>
                {transitions.map((k) => (
                  <BrowserItem
                    key={k}
                    testId="transition-item"
                    name={TRANSITION_LABELS[k]}
                    title="Drop on the left half of a clip for its in edge, the right half for its out edge"
                    mime={TRANSITION_MIME}
                    payload={k}
                    disabled={!targetId}
                    onApply={() => targetId && setClipTransition(targetId, 'in', k)}
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
      className="cursor-default overflow-hidden rounded-[6px] border border-border bg-bg-elevated transition-colors duration-[120ms] ease-out hover:border-border-strong"
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
      title="Click to preview · double-click to add at the playhead"
      onClick={() => previewSfx(sfx.id)}
      onDoubleClick={() => void insertSfxAtPlayhead(sfx.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void insertSfxAtPlayhead(sfx.id)
      }}
      className="flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
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
      {empty && (
        <div
          data-testid="library-empty"
          className="mb-3 flex flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border-strong py-6 text-center"
        >
          <Bookmark size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[13px] text-text-secondary">Nothing saved yet</div>
          <div className="max-w-[200px] text-[11px] text-text-muted">
            Right-click media → Save to Library. Select a graded clip and save its effects as a preset.
          </div>
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
              title={`${p.effects.length} effect(s) — double-click to apply to the selected clip`}
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
      {leftTab === 'media' ? <MediaTab /> : leftTab === 'effects' ? <EffectsTab /> : <LibraryTab />}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex bg-black/60 p-4">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[6px] border-2 border-dashed border-accent bg-accent-quiet">
            <Upload size={24} strokeWidth={1.5} className="text-accent" aria-hidden />
            <div className="text-[14px] font-medium text-text-primary">Drop to import</div>
          </div>
        </div>
      )}
    </aside>
  )
}
