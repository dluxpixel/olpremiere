// Project switching: open / create / delete without ever deleting your work
// to start something new. The current project autosaves before any switch, so
// flipping between edits is lossless in both directions.

import { activeSequence, newProject } from '../engine/types'
import { useCollab } from '../collab/collabControl'
import { pausePlayback } from './playbackControl'
import { deleteProject, loadProjectById, saveNow, saveProject, setProjectArchived } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'
import { applyTemplateTracks } from './trackTemplate'

/** Switching projects inside a collab room would tear the room's doc out from
 * under the peers, so leave first (Leave already restores your solo project).
 * Exported because opening a project FILE replaces the document exactly the same
 * way, and it used to do it with none of these guards. */
export function guardRoom(): boolean {
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
 * failed: switching projects would then drop every unsaved edit, so the caller
 * must abort rather than "autosave first" in name only.
 */
export async function flushOutgoing(): Promise<boolean> {
  try {
    await saveNow()
    return true
  } catch {
    useToasts
      .getState()
      .show('Could not save this project. Staying here so nothing is lost', 'danger')
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

/**
 * File a finished project away, or bring it back out.
 *
 * Archiving is NOT deleting and must never feel like it: nothing is removed,
 * no media bytes are touched, and it is one click to reverse. It exists because
 * of what he said on 2026-08-05: *"I have a lot of projects that I finished that
 * I just don't want to delete because, why the hell would I delete them for no
 * reason, right?"*
 *
 * The OPEN project is refused, for the same reason deleting it is: the list he
 * is looking at should never disagree with the editor behind it.
 */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  if (id === useStore.getState().project.id) {
    useToasts.getState().show('Open another project first, then archive this one', 'danger')
    return
  }
  try {
    await setProjectArchived(id, archived)
  } catch (err) {
    // Never swallow this. The first version did, and a write that threw looked
    // exactly like a click that did nothing: the row just stayed put.
    console.error('OL Premiere: archiving failed', err)
    useToasts.getState().show('Could not file that project away', 'danger')
    return
  }
  useToasts.getState().show(archived ? 'Moved to finished' : 'Back in your projects')
}
