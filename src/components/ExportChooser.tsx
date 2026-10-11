import { FolderOpen, Pencil, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { startExport } from '../state/exportJob'
import {
  createPreset,
  deletePreset,
  findPreset,
  PRESET_NAME_MAX,
  renamePreset,
  setPresetFolder,
  useExportPresets,
  type ExportPreset,
} from '../state/exportPresets'
import { Button, IconButton } from '../ui/Button'

const NO_FOLDER_YET = 'Folder not chosen yet'

const fieldClass =
  'h-7 w-full rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none'

const rowClass = 'flex min-w-0 flex-1 cursor-default flex-col items-start gap-0.5 rounded-field px-3 py-2 text-left'

/**
 * The first thing the Export button shows on the desktop: which preset. A preset
 * is a name and its own folder (state/exportPresets.ts). Clicking one starts the
 * export, with the export window's settings as they are, into that folder; "Just
 * this once" is the plain export with the save dialog, as before.
 *
 * It sits in ExportDialog's own frame, so the window looks and closes like the
 * rest of Export. The list starts empty, with "New preset" as the way in.
 */
export function ExportChooser() {
  const presets = useExportPresets((s) => s.presets)
  const [editing, setEditing] = useState<string | null>(null)
  const [making, setMaking] = useState(false)

  return (
    <div className="flex min-h-0 flex-col" data-testid="export-chooser">
      <p className="shrink-0 px-4 pb-1 pt-3 text-[11px] text-text-muted">Choose a preset</p>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {presets.length === 0 && (
          <p className="px-2 py-1 text-[12px] text-text-muted" data-testid="export-no-presets">
            No presets yet.
          </p>
        )}
        {presets.map((preset) =>
          editing === preset.id ? (
            <PresetEditor key={preset.id} preset={preset} onDone={() => setEditing(null)} />
          ) : (
            <div
              key={preset.id}
              data-testid="export-preset-row"
              className="flex items-center gap-1 rounded-field pr-1 hover:bg-bg-input"
            >
              <button type="button" data-testid="export-preset-start" className={rowClass} onClick={() => startExport(preset.id)}>
                <span className="max-w-full truncate text-ui text-text-primary">{preset.name}</span>
                <span className="max-w-full truncate text-[11px] text-text-muted" title={preset.folder ?? undefined}>
                  {preset.folder ?? NO_FOLDER_YET}
                </span>
              </button>
              <IconButton
                label={`Edit ${preset.name}`}
                data-testid="export-preset-edit"
                onClick={() => {
                  setMaking(false)
                  setEditing(preset.id)
                }}
              >
                <Pencil size={14} strokeWidth={1.5} />
              </IconButton>
            </div>
          ),
        )}

        {making ? (
          <NewPresetForm onClose={() => setMaking(false)} />
        ) : (
          <button
            type="button"
            data-testid="export-new-preset"
            className="flex cursor-default items-center gap-2 rounded-field px-3 py-2 text-left hover:bg-bg-input"
            onClick={() => {
              setEditing(null)
              setMaking(true)
            }}
          >
            <Plus size={14} strokeWidth={1.5} className="shrink-0 text-accent" />
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="text-ui text-text-primary">New preset</span>
              <span className="text-[11px] text-text-muted">Name it, and it remembers its own folder</span>
            </span>
          </button>
        )}
      </div>

      <div className="mx-4 shrink-0 border-t border-border" />
      <div className="shrink-0 p-2">
        <button
          type="button"
          data-testid="export-once"
          className="flex w-full cursor-default flex-col items-start gap-0.5 rounded-field px-3 py-2 text-left hover:bg-bg-input"
          onClick={() => startExport(null)}
        >
          <span className="text-ui text-text-primary">Just this once</span>
          <span className="text-[11px] text-text-muted">Choose where to save this video</span>
        </button>
      </div>
    </div>
  )
}

/** Make a preset: a name. Its folder is asked for the first time it is used. */
function NewPresetForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const blank = name.trim() === ''

  const save = (thenExport: boolean): void => {
    if (blank) return
    const made = createPreset(name)
    if (!made) return
    onClose()
    if (thenExport) startExport(made.id)
  }

  return (
    <div data-testid="export-new-preset-form" className="flex flex-col gap-2 rounded-field border border-border p-3">
      <input
        ref={input}
        data-testid="export-preset-name"
        aria-label="Preset name"
        placeholder="Name, like Gym"
        value={name}
        maxLength={PRESET_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(true)
        }}
        className={fieldClass}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" data-testid="export-preset-save" disabled={blank} onClick={() => save(false)}>
          Save as preset
        </Button>
        <Button variant="primary" data-testid="export-preset-save-export" disabled={blank} onClick={() => save(true)}>
          Save and export
        </Button>
      </div>
    </div>
  )
}

/** Rename, change the folder or delete: each applies the moment he does it. */
function PresetEditor({ preset, onDone }: { preset: ExportPreset; onDone: () => void }) {
  const [name, setName] = useState(preset.name)

  // A blank name changes nothing, and a name another preset has comes back with a number.
  const commitName = (): void => {
    renamePreset(preset.id, name)
    setName(findPreset(preset.id)?.name ?? name)
  }
  const changeFolder = async (): Promise<void> => {
    const folder = await window.api?.exportPickFolder?.(`Folder for ${preset.name}`, preset.folder)
    if (folder) setPresetFolder(preset.id, folder)
  }

  return (
    <div data-testid="export-preset-editor" className="flex flex-col gap-2 rounded-field border border-border p-3">
      <input
        data-testid="export-preset-name"
        aria-label="Preset name"
        value={name}
        maxLength={PRESET_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitName()
            onDone()
          }
        }}
        className={fieldClass}
      />
      <div className="flex items-center gap-2">
        <span
          data-testid="export-preset-folder"
          className="min-w-0 flex-1 truncate text-[11px] text-text-muted"
          title={preset.folder ?? undefined}
        >
          {preset.folder ?? NO_FOLDER_YET}
        </span>
        <Button variant="secondary" data-testid="export-preset-change-folder" onClick={() => void changeFolder()}>
          <FolderOpen size={14} strokeWidth={1.5} />
          Change folder
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          data-testid="export-preset-delete"
          className="text-danger"
          onClick={() => {
            deletePreset(preset.id)
            onDone()
          }}
        >
          Delete
        </Button>
        <Button
          variant="primary"
          data-testid="export-preset-done"
          onClick={() => {
            commitName()
            onDone()
          }}
        >
          Done
        </Button>
      </div>
    </div>
  )
}
