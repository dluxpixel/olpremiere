import { Bookmark, Film, Folder, FolderPlus, Image as ImageIcon, Music, Play, Plus, Square, Volume2 } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { matchesQuery } from '../engine/effects/search'
import { SFX_LIBRARY, type SfxDef } from '../engine/sfx/sfx'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, type Id } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { openContextMenu } from '../state/contextMenu'
import { LIBRARY_MIME, SFX_MIME, dragHasType } from '../state/dnd'
import {
  addLibraryItemToProject,
  addLibraryItemToTimeline,
  applyPresetToAllClips,
  applyPresetToSelection,
  deleteLibraryCategory,
  moveLibraryItems,
  promptNewLibraryCategory,
  promptRenameLibraryCategory,
  removeLibraryItem,
  removePreset,
  setLibraryView,
  useLibrary,
  type LibraryItem,
} from '../state/library'
import {
  ALL_VIEW,
  UNSORTED_ID,
  UNSORTED_NAME,
  categoryCounts,
  categoryIdOf,
  categoryLabel,
  itemsInView,
  liveView,
  sortedCategories,
  type LibraryCategory,
} from '../state/libraryCategories'
import { moveToCategoryItems } from '../state/libraryMenus'
import { stopLibraryPreview, toggleLibraryPreview, useLibraryPreview } from '../state/libraryPreview'
import { insertSfxAtPlayhead, previewSfx } from '../state/sfxActions'
import { useStore } from '../state/store'

const KIND_ICONS = { video: Film, audio: Music, image: ImageIcon } as const

const SECTION_HEADING = 'text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary'

/** The small round buttons laid over a card's picture. */
const CARD_BUTTON =
  'absolute flex h-5 w-5 cursor-default items-center justify-center rounded-full bg-black/70 text-text-primary transition-colors duration-[120ms] hover:bg-accent hover:text-accent-fg'

// A button on a card is its own gesture: its clicks must not ALSO count as the
// card's double click, and its Enter must not ALSO run the card's Enter.
const keepToButton = {
  onDoubleClick: (e: MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
}

/**
 * One saved media entry.
 *
 * Enter, the + button, or a drag onto the timeline put it on the timeline.
 * Double click keeps what it has always done, bring it into this project's
 * Media bin, because the end to end Library test is built on exactly that.
 * A drag onto a category row files it there.
 */
function LibraryCard({ item, fps, categories }: { item: LibraryItem; fps: number; categories: LibraryCategory[] }) {
  const thumbUrl = useBlobUrl(item.thumbnailKey)
  const Icon = KIND_ICONS[item.kind]
  const playing = useLibraryPreview((s) => s.playingId === item.id)
  const where = categoryIdOf(item, categories)
  const addToTimeline = (): void => void addLibraryItemToTimeline(item.id)

  // A card that goes away (removed, filtered out, another category picked)
  // takes its sound with it, instead of leaving a song playing from nowhere.
  useEffect(
    () => () => {
      if (useLibraryPreview.getState().playingId === item.id) stopLibraryPreview()
    },
    [item.id],
  )

  return (
    <div
      data-testid="library-card"
      data-category-id={where}
      role="button"
      tabIndex={0}
      draggable
      title="Enter or + puts it on the timeline. Double-click adds it to this project's media. Drag it to the timeline, or onto a category to move it."
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_MIME, item.id)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onDoubleClick={() => void addLibraryItemToProject(item.id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        // The edit is on the timeline now, so a following Delete belongs there.
        e.currentTarget.blur()
        addToTimeline()
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add at playhead', shortcut: 'Enter', onClick: addToTimeline },
          { label: 'Add to project', onClick: () => void addLibraryItemToProject(item.id) },
          { label: 'Move to', submenu: moveToCategoryItems([item.id], where) },
          {
            label: 'Remove from Library',
            danger: true,
            separator: true,
            onClick: () => void removeLibraryItem(item.id),
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
        <button
          type="button"
          data-testid="library-add"
          aria-label={`Add ${item.name} at the playhead`}
          title="Add at the playhead"
          onClick={addToTimeline}
          {...keepToButton}
          className={`${CARD_BUTTON} top-1 right-1`}
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
        </button>
        {item.kind === 'audio' && (
          <button
            type="button"
            data-testid="library-preview"
            aria-label={playing ? `Stop ${item.name}` : `Play ${item.name}`}
            aria-pressed={playing}
            title={playing ? 'Stop' : 'Listen'}
            onClick={() => void toggleLibraryPreview(item)}
            {...keepToButton}
            className={`${CARD_BUTTON} bottom-1 left-1 ${playing ? 'bg-accent text-accent-fg' : ''}`}
          >
            {playing ? (
              <Square size={9} strokeWidth={2} fill="currentColor" aria-hidden />
            ) : (
              <Play size={10} strokeWidth={2} fill="currentColor" aria-hidden />
            )}
          </button>
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

/**
 * One place in the Library: All, Unsorted, or a category he named. Click shows
 * it. A category he made also renames on a double click, has a right-click
 * menu, and takes a Library card dropped on it.
 */
function CategoryRow({
  id,
  label,
  count,
  active,
  named,
}: {
  id: Id
  label: string
  count: number
  active: boolean
  named: boolean
}) {
  const [over, setOver] = useState(false)
  const takesDrops = id !== ALL_VIEW
  return (
    <div
      data-testid="library-category"
      data-category-id={id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => setLibraryView(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setLibraryView(id)
        }
      }}
      onDoubleClick={named ? () => void promptRenameLibraryCategory(id) : undefined}
      onContextMenu={
        named
          ? (e) =>
              openContextMenu(e, [
                { label: 'Rename...', onClick: () => void promptRenameLibraryCategory(id) },
                {
                  // "Remove", the app's one word for taking something off a
                  // list, and the label says out loud that the sounds stay.
                  label: 'Remove category (keeps its items)',
                  danger: true,
                  separator: true,
                  onClick: () => void deleteLibraryCategory(id),
                },
              ])
          : undefined
      }
      onDragOver={
        takesDrops
          ? (e) => {
              if (!dragHasType(e.dataTransfer.types, LIBRARY_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOver(true)
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        takesDrops
          ? (e) => {
              setOver(false)
              const itemId = e.dataTransfer.getData(LIBRARY_MIME)
              if (!itemId) return
              e.preventDefault()
              void moveLibraryItems([itemId], id)
            }
          : undefined
      }
      className={`flex cursor-default items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] transition-colors duration-[120ms] ${
        active ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
      } ${over ? 'ring-1 ring-accent' : ''}`}
    >
      {/* No pointer events inside, so a drag moving across the icon or the
          name does not read as leaving the row and flicker the highlight. */}
      <Folder size={13} strokeWidth={1.5} aria-hidden className="pointer-events-none shrink-0 text-text-muted" />
      <span className="pointer-events-none truncate">{label}</span>
      <span className="pointer-events-none ml-auto shrink-0 text-[10px] text-text-muted tabular-nums">{count}</span>
    </div>
  )
}

function CategoryList({
  categories,
  counts,
  view,
  hasAny,
}: {
  categories: LibraryCategory[]
  counts: Map<Id, number>
  view: string
  hasAny: boolean
}) {
  return (
    <section data-testid="library-categories" className="mb-3">
      <div className="flex items-center justify-between px-0.5 pb-1">
        <h3 className={SECTION_HEADING}>Categories</h3>
        <button
          type="button"
          data-testid="library-new-category"
          aria-label="New category"
          title="Make a category, like Battle Cats"
          onClick={() => void promptNewLibraryCategory()}
          className="flex cursor-default items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
        >
          <FolderPlus size={12} strokeWidth={1.5} aria-hidden />
          New
        </button>
      </div>
      {hasAny && (
        <>
          <CategoryRow id={ALL_VIEW} label="All" count={counts.get(ALL_VIEW) ?? 0} active={view === ALL_VIEW} named={false} />
          <CategoryRow
            id={UNSORTED_ID}
            label={UNSORTED_NAME}
            count={counts.get(UNSORTED_ID) ?? 0}
            active={view === UNSORTED_ID}
            named={false}
          />
          {sortedCategories(categories).map((c) => (
            <CategoryRow key={c.id} id={c.id} label={c.name} count={counts.get(c.id) ?? 0} active={view === c.id} named />
          ))}
        </>
      )}
      <p className="px-0.5 pt-1 text-[10px] text-text-muted">
        {categories.length === 0
          ? 'Make one for each thing you save for, like Battle Cats.'
          : 'Right-click a category to rename or remove it. Drag a card onto one to move it.'}
      </p>
    </section>
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
      onClick={() => {
        // One sound at a time: a saved sound still playing would talk over it.
        stopLibraryPreview()
        previewSfx(sfx.id)
      }}
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

export function LibraryTab() {
  const items = useLibrary((s) => s.items)
  const presets = useLibrary((s) => s.presets)
  const categories = useLibrary((s) => s.categories)
  const pickedView = useLibrary((s) => s.view)
  const view = liveView(pickedView, categories)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const hasSelection = useStore((s) => s.ui.selection.length === 1)
  const [query, setQuery] = useState('')

  // Leaving the tab stops a sound he was listening to.
  useEffect(() => () => stopLibraryPreview(), [])

  const empty = items.length === 0 && presets.length === 0
  const counts = categoryCounts(items, categories)
  const shownItems = itemsInView(items, categories, view, query)
  const shownPresets = presets.filter((p) => matchesQuery(query, p.name, 'preset'))
  const shownSfx = SFX_LIBRARY.filter((s) => matchesQuery(query, s.name, 'sound effect'))
  const filtering = query.trim() !== ''
  const noMatch = filtering && shownItems.length === 0 && shownPresets.length === 0 && shownSfx.length === 0
  const viewName = categoryLabel(view, categories)
  // While filtering, a view with no match steps aside for the sections that do
  // match, and the one "No match" line covers the rest.
  const showMedia = items.length > 0 && !(filtering && shownItems.length === 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter library"
          aria-label="Filter the library"
          data-testid="library-filter"
          className="h-7 w-full rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-0">
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
        <CategoryList categories={categories} counts={counts} view={view} hasAny={items.length > 0 || categories.length > 0} />
        {showMedia && (
          <section className="mb-3">
            <h3 className={`px-0.5 pb-1.5 ${SECTION_HEADING}`}>{view === ALL_VIEW ? 'Media' : `Media · ${viewName}`}</h3>
            {shownItems.length > 0 ? (
              <div className="grid grid-cols-2 content-start gap-2">
                {shownItems.map((item) => (
                  <LibraryCard key={item.id} item={item} fps={fps} categories={categories} />
                ))}
              </div>
            ) : (
              <p data-testid="library-view-empty" className="px-0.5 text-[11px] text-text-muted">
                {view === UNSORTED_ID
                  ? 'Nothing unsorted.'
                  : `Nothing in ${viewName} yet. Right-click any media item, then Save to a category.`}
              </p>
            )}
          </section>
        )}
        {shownPresets.length > 0 && (
          <section>
            <h3 className={`px-0.5 pb-1 ${SECTION_HEADING}`}>Effect presets</h3>
            {!hasSelection && (
              <p className="px-0.5 pb-1 text-[10px] text-text-muted">
                Select a clip to apply one, or right-click → Apply to every clip.
              </p>
            )}
            {shownPresets.map((p) => (
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
        {shownSfx.length > 0 && (
          <section className={showMedia || shownPresets.length > 0 ? 'mt-3' : ''}>
            <h3 className={`px-0.5 pb-1 ${SECTION_HEADING}`}>Sound effects</h3>
            <p className="px-0.5 pb-1 text-[10px] text-text-muted">
              Click to preview · double-click to drop at the playhead.
            </p>
            {shownSfx.map((sfx) => (
              <SfxRow key={sfx.id} sfx={sfx} />
            ))}
          </section>
        )}
        {noMatch && (
          <div data-testid="library-no-match" className="px-2 py-6 text-center text-[11px] text-text-muted">
            No match for &ldquo;{query.trim()}&rdquo;
          </div>
        )}
      </div>
    </div>
  )
}
