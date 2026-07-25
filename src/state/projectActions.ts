// Project switching: open / create / delete without ever deleting your work
// to start something new. The current project autosaves before any switch, so
// flipping between edits is lossless in both directions.

import { activeSequence, newProject } from '../engine/types'
import { useCollab } from '../collab/collabControl'
import { pausePlayback } from './playbackControl'
import { deleteProject, loadProjectById, saveNow, saveProject } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'
import { applyTemplateTracks } from './trackTemplate'

/** Switching projects inside a collab room would tear the room's doc out from
 * under the peers — leave first (Leave already restores your solo project). */
function guardRoom(): boolean {
  if (useCollab.getState().session !== null) {
    useToasts.getState().show('Leave the room before switching projects', 'danger')
    return false
  }
  return true
}

function adopt(projectName: string, apply: () => void): void {
  pausePlayback()
  apply()
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
  useToasts.getState().show(`Opened “${projectName}”`, 'success')
}

/**
 * Flush the open project before it is replaced. Returns false when the write
 * failed — switching projects would then drop every unsaved edit, so the caller
 * must abort rather than "autosave first" in name only.
 */
async function flushOutgoing(): Promise<boolean> {
  try {
    await saveNow()
    return true
  } catch {
    useToasts
      .getState()
      .show('Could not save this project — staying here so nothing is lost', 'danger')
    return false
  }
}

/** Open another saved project (current one autosaves first). */
export async function openProject(id: string): Promise<void> {
  if (!guardRoom()) return
  if (id === useStore.getState().project.id) return
  if (!(await flushOutgoing())) return
  const p = await loadProjectById(id)
  if (!p) {
    useToasts.getState().show('That project could not be loaded', 'danger')
    return
  }
  adopt(p.name, () => useStore.getState().setProject(p))
  // Make this the boot project even if the user edits nothing.
  await saveProject(p)
}

/** Start a fresh project (current one autosaves first). */
export async function createProject(): Promise<void> {
  if (!guardRoom()) return
  if (!(await flushOutgoing())) return
  const p = newProject()
  // A saved track template replaces the stock V1/V2/A1/A2 layout. `p` is
  // still private here, so patching it before adopt() touches no shared state.
  const seq = activeSequence(p)
  const tracks = applyTemplateTracks(seq.tracks)
  if (tracks !== seq.tracks) p.sequences[seq.id] = { ...seq, tracks }
  adopt(p.name, () => useStore.getState().setProject(p))
  await saveProject(p)
}

/** Delete a NON-open project and its media bytes. */
export async function removeProject(id: string): Promise<void> {
  if (id === useStore.getState().project.id) {
    useToasts.getState().show('Open another project first, then delete this one', 'danger')
    return
  }
  await deleteProject(id)
  useToasts.getState().show('Project deleted')
}
