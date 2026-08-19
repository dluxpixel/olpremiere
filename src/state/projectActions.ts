// Project switching: open / create / delete without ever deleting your work
// to start something new. The current project autosaves before any switch, so
// flipping between edits is lossless in both directions.

import { activeSequence, newProject } from '../engine/types'
import { sampleFromClips } from '../engine/captions/styleLearning'
import { rememberProjectStyle } from '../engine/captions/styleStore'
import { useCollab } from '../collab/collabControl'
import { pausePlayback } from './playbackControl'
import { deleteProject, listProjects, loadProjectById, saveNow, saveProject, setProjectArchived, setProjectLater } from './persistence'
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

/**
 * Delete a project and its media bytes, INCLUDING the one that is open.
 *
 * His ask, 2026-08-14: the archive, later and delete buttons should be there on
 * the row he is looking at even when that project is the open one. This used to
 * refuse, so he had to open something else first purely to satisfy the app.
 *
 * ⛔ THE ORDER IS THE WHOLE THING. Deleting first would leave the editor holding
 * a project that no longer exists, and the very next autosave would write it
 * straight back. So the successor is opened FIRST, and only a switch that
 * actually happened earns the delete: `openProject` aborts when the outgoing
 * save fails, and this must abort with it rather than delete anyway.
 */
export async function removeProject(id: string): Promise<void> {
  if (id !== useStore.getState().project.id) {
    await deleteProject(id)
    useToasts.getState().show('Project deleted')
    return
  }
  if (!guardRoom()) return

  // Land somewhere before the ground goes: the most recently touched project
  // that is not this one, or a fresh one when this was the last.
  const others = (await listProjects()).filter((p) => p.id !== id)
  const successor = others.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (successor) await openProject(successor.id)
  else await createProject()

  if (useStore.getState().project.id === id) {
    // The switch was refused, and it has already said why. Deleting now would
    // pull the file out from under the editor still showing it.
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
 * ⛔ THE OPEN PROJECT USED TO BE REFUSED and is not any more, at his ask on
 * 2026-08-14. The old reason was that "the list should never disagree with the
 * editor behind it", and that was the wrong worry: filing a project away only
 * moves which shelf its row sits on. Nothing closes, nothing is lost, he keeps
 * editing, and it is one click back. Having to open some other project first
 * purely to satisfy the app was the actual disagreement.
 */
/**
 * Move a project between "now" and "later". Same shape as setArchived, and the
 * open project is allowed here for the same reason.
 */
export async function setLater(id: string, later: boolean): Promise<void> {
  try {
    await setProjectLater(id, later)
  } catch (err) {
    console.error('OL Premiere: parking failed', err)
    useToasts.getState().show('Could not move that project', 'danger')
    return
  }
  useToasts.getState().show(later ? 'Parked for later' : 'Back in what you are working on')
}

/**
 * Read a finished project's captions and keep what they teach.
 *
 * His ask, 2026-08-19: *"Whenever I archive a project and I use captions in it,
 * make sure it learns from my speech patterns."* Archiving is the moment he
 * says a video is done, which is the only moment its captions are finished
 * enough to learn from.
 *
 * ⛔ IT CAN NEVER FAIL THE ARCHIVE. Filing a project away is his action and it
 * has to work whatever the learning does, so every error here is swallowed
 * after being logged. A project that teaches nothing is a project that teaches
 * nothing; a project he cannot file away is a bug he would feel.
 */
async function learnFromArchived(id: string): Promise<void> {
  try {
    const project = await loadProjectById(id)
    if (!project) return
    const clips = Object.values(project.sequences).flatMap((seq) =>
      seq.tracks.flatMap((t) => t.clips),
    )
    const sample = sampleFromClips(clips)
    if (!sample) return
    rememberProjectStyle(id, sample, project.archivedAt ?? Date.now())
  } catch (err) {
    console.error('OL Premiere: learning from the archived captions failed', err)
  }
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  try {
    await setProjectArchived(id, archived)
  } catch (err) {
    // Never swallow this. The first version did, and a write that threw looked
    // exactly like a click that did nothing: the row just stayed put.
    console.error('OL Premiere: archiving failed', err)
    useToasts.getState().show('Could not file that project away', 'danger')
    return
  }
  // AFTER the archive has actually landed, and only on the way in. Un-archiving
  // is him pulling the work back out to change it, and forgetting what it
  // taught at that moment would throw away a finished video's worth of his
  // style over an edit he may not even make.
  if (archived) await learnFromArchived(id)
  useToasts.getState().show(archived ? 'Moved to finished' : 'Back in your projects')
}
