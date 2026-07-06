import { Film, FolderOpen, Image as ImageIcon, Music, Plus, Sparkles, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, type MediaAsset } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { openContextMenu } from '../state/contextMenu'
import { deleteAsset, importFiles, insertAssetAtPlayhead } from '../state/mediaActions'
import { useStore, type LeftTab } from '../state/store'
import { Button } from '../ui/Button'

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
        e.dataTransfer.setData('application/x-reel-asset', asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={() => insertAssetAtPlayhead(asset.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') insertAssetAtPlayhead(asset.id)
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add to timeline', shortcut: 'Enter', onClick: () => insertAssetAtPlayhead(asset.id) },
          {
            label: 'Delete from bin',
            danger: true,
            separator: true,
            onClick: () => deleteAsset(asset.id),
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
  const list = Object.values(assets)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          <Plus size={16} strokeWidth={1.5} />
          Import
        </Button>
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

function EffectsTab() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Sparkles size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
      <div className="text-[13px] text-text-secondary">Effects &amp; transitions</div>
      <div className="text-[11px] text-text-muted">Arriving in Phase 4</div>
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
      </div>
      {leftTab === 'media' ? <MediaTab /> : <EffectsTab />}
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
