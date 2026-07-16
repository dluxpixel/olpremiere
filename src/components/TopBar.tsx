import {
  ChevronDown,
  Circle,
  Clapperboard,
  Download,
  FolderOpen,
  HardDriveDownload,
  LayoutGrid,
  Keyboard,
  Mic,
  Redo2,
  Square,
  Undo2,
  Users,
} from 'lucide-react'
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react'
import {
  enterRoom,
  leaveRoom,
  performHistoryStep,
  setDisplayName,
  storedDisplayName,
  useCollab,
} from '../collab/collabControl'
import { comboLabel } from '../keymap'
import { openContextMenu } from '../state/contextMenu'
import { exportProjectToFile, importProjectFromFile } from '../state/projectFile'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import {
  canRecordVoice,
  listAudioInputs,
  setEnhance,
  setInputDevice,
  startRecording,
  stopRecording,
  useRecorder,
} from '../state/voiceRecorder'
import { Button, IconButton } from '../ui/Button'
import { ExportDialog } from './ExportDialog'
import { ProjectsDialog } from './ProjectsDialog'

/**
 * "Edit together" — create/share a live room, or show who's in it. The badge is
 * honest about reach: the relay origin syncs across machines, elsewhere the
 * room spans tabs on this machine only.
 */
function CollabButton() {
  const roomId = useCollab((s) => s.roomId)
  const peers = useCollab((s) => s.peers)
  const mode = useCollab((s) => s.mode)
  const connected = useCollab((s) => s.connected)
  const [editingName, setEditingName] = useState(false)

  if (!roomId) {
    return (
      <Button variant="secondary" data-testid="collab-start" onClick={() => void enterRoom()}>
        <Users size={16} strokeWidth={1.5} />
        Edit together
      </Button>
    )
  }
  if (editingName) {
    return (
      <input
        autoFocus
        data-testid="collab-name-input"
        aria-label="Your display name"
        defaultValue={storedDisplayName()}
        maxLength={24}
        className="h-7 w-36 rounded-[4px] border border-accent bg-bg-input px-2 text-[12px] text-text-primary focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setDisplayName(e.currentTarget.value)
            setEditingName(false)
          } else if (e.key === 'Escape') setEditingName(false)
        }}
        onBlur={(e) => {
          setDisplayName(e.currentTarget.value)
          setEditingName(false)
        }}
      />
    )
  }
  return (
    <div className="flex items-center gap-1.5" data-testid="collab-badge">
      <span
        role="button"
        tabIndex={0}
        onClick={() => setEditingName(true)}
        onKeyDown={(e) => e.key === 'Enter' && setEditingName(true)}
        className="flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-accent/40 bg-accent-quiet px-2 py-1 text-[11px] text-accent"
        title={`${
          mode === 'relay'
            ? `Live room ${roomId} — anyone with the link edits with you`
            : `Live room ${roomId} — tabs on THIS machine (deploy with the relay for cross-machine)`
        } · click to set your name`}
      >
        <span className="relative flex h-2 w-2">
          {connected && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-accent' : 'bg-yellow-500'}`}
          />
        </span>
        {!connected
          ? 'Reconnecting…'
          : peers.length === 0
            ? 'Waiting for others…'
            : `${peers.length + 1} editing`}
        {peers.slice(0, 4).map((p) => (
          <span
            key={p.clientId}
            title={p.name}
            className="inline-block h-2.5 w-2.5 rounded-full border border-black/30"
            style={{ background: p.color }}
          />
        ))}
      </span>
      <Button variant="secondary" data-testid="collab-leave" onClick={leaveRoom}>
        Leave
      </Button>
    </div>
  )
}

/** Record a voiceover from the mic; the take lands in the bin as an audio clip. */
function RecordButton() {
  const recording = useRecorder((s) => s.recording)
  const startedAt = useRecorder((s) => s.startedAt)
  const selectedInputId = useRecorder((s) => s.selectedInputId)
  const enhance = useRecorder((s) => s.enhance)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!recording || startedAt === null) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [recording, startedAt])

  if (!canRecordVoice()) return null

  // Open the input-device menu at the cursor: system default first, then every
  // audio input, with a ✓ on the active one. Fixes "I recorded but got silence"
  // when the OS default isn't the mic being spoken into.
  const chooseDevice = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    const { clientX, clientY } = e
    const inputs = await listAudioInputs()
    const check = (on: boolean, label: string) => (on ? `${label}  ✓` : label)
    openContextMenu({ preventDefault: () => {}, clientX, clientY }, [
      {
        label: check(selectedInputId === null, 'System default'),
        onClick: () => setInputDevice(null),
      },
      ...inputs.map((d, i) => ({
        label: check(d.deviceId === selectedInputId, d.label || `Microphone ${i + 1}`),
        onClick: () => setInputDevice(d.deviceId),
        separator: i === 0,
      })),
      {
        // On by default: RNNoise removes cars / fans / hum while keeping the
        // voice (see noiseChain.ts). Off = pristine raw capture.
        label: check(enhance, 'Reduce background noise'),
        onClick: () => setEnhance(!enhance),
        separator: true,
      },
    ])
  }

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  return (
    <span className="flex items-center gap-0.5">
      <IconButton
        label={recording ? 'Stop recording' : 'Record voiceover'}
        active={recording}
        data-testid="record-voice"
        onClick={() => (recording ? stopRecording() : void startRecording())}
      >
        {recording ? (
          <Square size={14} strokeWidth={2} className="text-danger" fill="currentColor" />
        ) : (
          <Mic size={16} strokeWidth={1.5} />
        )}
      </IconButton>
      <IconButton
        size="compact"
        label="Choose microphone"
        disabled={recording}
        data-testid="record-device"
        onClick={(e) => void chooseDevice(e)}
      >
        <ChevronDown size={13} strokeWidth={1.5} />
      </IconButton>
      {recording && (
        <span data-testid="record-elapsed" className="ml-1 flex items-center gap-1 text-[11px] tabular-nums text-danger">
          <Circle size={7} fill="currentColor" className="animate-pulse" aria-hidden />
          {mmss}
        </span>
      )}
    </span>
  )
}

function SaveIndicator() {
  const saveState = useStore((s) => s.ui.saveState)
  // Persistent risk shouts, transient states whisper: unsaved work is the one
  // state that must be noticed; saving is a flicker.
  const dot =
    saveState === 'saved'
      ? 'bg-success'
      : saveState === 'saving'
        ? 'bg-text-muted animate-pulse'
        : 'bg-warning'
  const label = saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'
  return (
    <span
      data-testid="save-state"
      className="flex items-center gap-1.5 text-[11px] text-text-secondary"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

function ProjectName() {
  const name = useStore((s) => s.project.name)
  const dispatch = useStore((s) => s.dispatch)
  const [draft, setDraft] = useState(name)

  useEffect(() => setDraft(name), [name])

  const commit = () => {
    const next = draft.trim()
    if (next === '' || next === name) {
      setDraft(name)
      return
    }
    dispatch('Rename project', (p) => ({ ...p, name: next }))
  }

  return (
    <input
      data-testid="project-name"
      aria-label="Project name"
      className="h-7 w-52 rounded-[4px] border border-transparent bg-transparent px-2 text-[13px] font-medium text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated focus:border-accent focus:bg-bg-input focus:outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(name)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function TopBar() {
  const canUndo = useStore((s) => s.history.undo.length > 0)
  const canRedo = useStore((s) => s.history.redo.length > 0)
  // Tooltips say WHAT will be undone; history entries already carry labels.
  const nextUndo = useStore((s) => s.history.undo[s.history.undo.length - 1]?.label)
  const nextRedo = useStore((s) => s.history.redo[s.history.redo.length - 1]?.label)
  // Routed through collab: rebased in a room, snapshot solo. The keymap route
  // toasts the label (App.tsx) — the buttons must not be the silent path.
  const undo = () => {
    const label = performHistoryStep('undo')
    if (label) useToasts.getState().show(`Undo: ${label}`)
  }
  const redo = () => {
    const label = performHistoryStep('redo')
    if (label) useToasts.getState().show(`Redo: ${label}`)
  }
  const setUI = useStore((s) => s.setUI)
  const [exporting, setExporting] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const openFileRef = useRef<HTMLInputElement>(null)

  return (
    <header
      data-testid="topbar"
      className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-panel px-3"
    >
      <div className="flex items-center gap-2">
        <Clapperboard size={18} className="text-accent" aria-hidden />
        <span className="text-[13px] font-semibold tracking-[0.08em]">OL Studio</span>
      </div>
      <div className="h-4 w-px bg-border" />
      <ProjectName />
      <IconButton
        label="Projects — switch or start another edit"
        onClick={() => setProjectsOpen(true)}
        data-testid="open-projects"
      >
        <LayoutGrid size={16} strokeWidth={1.5} />
      </IconButton>
      <SaveIndicator />

      {/* Manual save/restore to a self-contained file — a backup for when the
          in-browser autosave can't be trusted. */}
      <input
        ref={openFileRef}
        type="file"
        accept=".olstudio,.json,.olstudio.json,application/json,application/octet-stream"
        className="hidden"
        data-testid="open-project-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void importProjectFromFile(file)
          e.target.value = '' // allow re-opening the same file
        }}
      />
      <IconButton
        label="Save project to a file (backup)"
        onClick={() => void exportProjectToFile()}
        data-testid="save-project-file"
      >
        <HardDriveDownload size={16} strokeWidth={1.5} />
      </IconButton>
      <IconButton
        label="Open a project file"
        onClick={() => openFileRef.current?.click()}
        data-testid="open-project-file"
      >
        <FolderOpen size={16} strokeWidth={1.5} />
      </IconButton>

      <div className="ml-auto flex items-center gap-1">
        <IconButton
          label={nextUndo ? `Undo: ${nextUndo}` : 'Undo'}
          shortcut={comboLabel('mod+z')}
          onClick={undo}
          disabled={!canUndo}
          data-testid="undo"
        >
          <Undo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label={nextRedo ? `Redo: ${nextRedo}` : 'Redo'}
          shortcut={comboLabel('mod+shift+z')}
          onClick={redo}
          disabled={!canRedo}
          data-testid="redo"
        >
          <Redo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label="Keyboard shortcuts"
          shortcut="?"
          onClick={() => setUI({ helpOpen: true })}
          data-testid="help-open"
        >
          <Keyboard size={16} strokeWidth={1.5} />
        </IconButton>
        <div className="mx-2 h-4 w-px bg-border" />
        <CollabButton />
        <RecordButton />
        <Button variant="primary" data-testid="export-open" onClick={() => setExporting(true)}>
          <Download size={16} strokeWidth={1.5} />
          Export
        </Button>
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {projectsOpen && <ProjectsDialog onClose={() => setProjectsOpen(false)} />}
    </header>
  )
}
