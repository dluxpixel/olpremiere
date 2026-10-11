// Project switching: open / create / delete without ever deleting your work
// to start something new. The current project autosaves before any switch, so
// flipping between edits is lossless in both directions.
//
// Since 2026-10-03 every open lands in an edit tab (editTabs.ts): the Projects
// dialog's Open adds a tab, or focuses the one already open, and the edit he
// leaves stays in the strip, saved and asleep.

import { create } from 'zustand'
import { reachableBlobKeys } from '../engine/blobGc'
import { activeSequence, newId, newProject, type Project } from '../engine/types'
import { nextFreeName } from '../engine/uniqueName'
import { startFrame, type ProjectStart } from '../components/frameFormats'
import { sampleFromClips } from '../engine/captions/styleLearning'
import { rememberProjectStyle } from '../engine/captions/styleStore'
import { flushOutgoing, forgetTab, guardRoom, neighbourTabs, switchTo } from './editTabs'
import {
  deleteProject,
  dropUnusedBlobs,
  listProjects,
  loadProjectById,
  saveProject,
  setProjectArchived,
  setProjectLater,
} from './persistence'
import { forgetDoNotAutoRecover } from './recoveryMemory'
import { useStore } from './store'
import { useToasts } from './toasts'
import { applyTemplateTracks } from './trackTemplate'

// Where they lived before the tabs; opening a project file still reaches them here.
export { flushOutgoing, guardRoom }

/** Open another saved project in a tab (the current one autosaves first). */
export async function openProject(id: string): Promise<void> {
  await switchTo(id, { announce: true })
}

/**
 * Start a fresh project in a new tab (the current one autosaves first). `start` is the
 * shape it opens in: wide as ever, or the phone screen shape for a Shorts project.
 */
export async function createProject(start: ProjectStart = 'wide'): Promise<void> {
  if (!guardRoom()) return
  if (!(await flushOutgoing())) return
  // A name no other project has, so its exports and files are told apart
  // (engine/uniqueName.ts, his ask 2026-09-28).
  let taken = new Set<string>()
  try {
    taken = new Set((await listProjects()).map((s) => s.name))
  } catch {
    // Unknown names only cost the plain name, never the new project.
  }
  const p = newProject(nextFreeName('Untitled Project', taken), startFrame(start))
  // A saved track template replaces the stock V1/V2/A1/A2 layout. `p` is
  // still private here, so patching it before it is adopted touches no shared state.
  const seq = activeSequence(p)
  const tracks = applyTemplateTracks(seq.tracks)
  if (tracks !== seq.tracks) p.sequences[seq.id] = { ...seq, tracks }
  if ((await switchTo(p, { announce: true })) !== 'ok') return
  await saveProject(p)
}

/**
 * `source` as a brand new project called `name`: its own id, fresh sequence ids,
 * and the SAME media (asset ids and byte keys), so no footage is copied.
 *
 * Sharing the bytes is safe and already happens: a recovered project shares its
 * media the same way, a delete keeps every key another project still uses
 * (`blobKeysOnlyUsedBy`), the sweep keeps the union of every project, and the
 * spare copies on disk are by asset id. Fresh sequence ids for the reason
 * `landRestored` gives: two projects must never share one.
 */
export function copyOfProject(source: Project, name: string, now = Date.now()): Project {
  const sequenceIdMap = new Map<string, string>()
  const sequences: Project['sequences'] = {}
  for (const [oldId, sq] of Object.entries(source.sequences)) {
    const freshId = newId()
    sequenceIdMap.set(oldId, freshId)
    sequences[freshId] = { ...sq, id: freshId }
  }
  const copy: Project = {
    ...source,
    id: newId(),
    name,
    sequences,
    activeSequenceId:
      sequenceIdMap.get(source.activeSequenceId) ?? Object.keys(sequences)[0] ?? source.activeSequenceId,
    createdAt: now,
    updatedAt: now,
  }
  // A new video is work he is on now, whatever shelf the old one sat on.
  delete copy.archivedAt
  delete copy.laterAt
  return copy
}

/**
 * MAKE A COPY to start a new video from an old one, and open it in a tab.
 *
 * His Projects folder holds "BC template 1" to "BC template 5", full edits he
 * reuses (his words, 2026-10-01: *"when I use a template for an old video and
 * then I make new stuff in the video"*). With no copy he edited the old video in
 * place, so the old edit was gone. The copy is named the _1 _2 way he asked for
 * (engine/uniqueName.ts). Resolves true when the copy is the open edit.
 */
export async function duplicateProject(id: string): Promise<boolean> {
  const show = useToasts.getState().show
  const live = useStore.getState().project
  // The open one is copied as it is on screen: the store copy can be a second behind.
  const source = id === live.id ? live : await loadProjectById(id)
  if (!source) {
    show('That project could not be read, so no copy was made', 'danger')
    return false
  }
  let taken = new Set<string>()
  try {
    taken = new Set((await listProjects()).map((s) => s.name))
  } catch {
    // Unknown names only cost the plain name, never the copy.
  }
  // The open edit's name as it is now: a rename can be a second ahead of the list.
  taken.add(live.name)
  const copy = copyOfProject(source, nextFreeName(source.name, taken))
  try {
    // Saved BEFORE the switch, so the copy exists even when the switch says no.
    await saveProject(copy)
  } catch (err) {
    console.error('OL Premiere: the copy could not be saved', err)
    show('Could not make the copy. Nothing was changed', 'danger')
    return false
  }
  if ((await switchTo(copy)) !== 'ok') {
    show(`Made a copy: ${copy.name}. It is in your projects`, 'info')
    return false
  }
  show(`Made a copy: ${copy.name}`, 'success')
  return true
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
    await deleteWithUndo(id, false)
    return
  }
  if (!guardRoom()) return

  // Land somewhere before the ground goes: the tab beside it, the way closing a
  // tab lands, else the most recently touched project that is not this one, or a
  // fresh one when this was the last.
  const others = (await listProjects()).filter((p) => p.id !== id)
  const exists = new Set(others.map((p) => p.id))
  const successor =
    neighbourTabs(id).find((t) => t !== id && exists.has(t)) ?? others.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
  if (successor) await openProject(successor)
  else await createProject()

  if (useStore.getState().project.id === id) {
    // The switch was refused, and it has already said why. Deleting now would
    // pull the file out from under the editor still showing it.
    return
  }
  await deleteWithUndo(id, true)
}

/** How long "Project deleted" offers its Undo, and so how long the media wait for it. */
export const UNDO_DELETE_MS = 10_000

/**
 * Bumped when a project comes back by Undo, so a Projects list on screen reads
 * itself again: the toast sits above the dialog, and the row must reappear.
 */
export const useProjectListStamp = create<{ stamp: number }>(() => ({ stamp: 0 }))

/**
 * ⛔ A DELETE HE CAN TAKE BACK. Two quick clicks delete a project, and before this
 * nothing in the app could reach it again, though the file sat in Trash and the
 * footage in the spare copies (ten of his projects are in Trash today). The
 * document is kept in hand and the media stay in the store while the toast offers
 * Undo; after that the media go, unless something uses them again. A close in
 * that window leaves them for the next start's sweep, which reclaims them.
 */
async function deleteWithUndo(id: string, wasOpen: boolean): Promise<void> {
  const gone = await deleteProject(id, { keepBytes: true })
  // A deleted project asleep in a tab leaves the strip with it.
  forgetTab(id)
  if (!gone) {
    useToasts.getState().show('Project deleted')
    return
  }
  const keys = [...reachableBlobKeys(gone)]
  let undone = false
  const letGo = setTimeout(() => {
    void dropUnusedBlobs(keys).catch((err) => console.warn('OL Premiere: could not free a deleted project', err))
  }, UNDO_DELETE_MS + 1000)
  useToasts.getState().show(
    'Project deleted',
    'info',
    {
      label: 'Undo',
      onClick: () => {
        if (undone) return
        undone = true
        clearTimeout(letGo)
        void putBack(gone, wasOpen)
      },
    },
    { durationMs: UNDO_DELETE_MS },
  )
}

/** Undo a delete: the same document, same id, same media, back in the list (and open, if it was). */
async function putBack(p: Project, reopen: boolean): Promise<void> {
  try {
    await saveProject(p)
  } catch (err) {
    console.error('OL Premiere: could not put the project back', err)
    useToasts.getState().show('Could not put the project back', 'danger')
    return
  }
  forgetDoNotAutoRecover([p.id])
  useProjectListStamp.setState((s) => ({ stamp: s.stamp + 1 }))
  if (reopen) await openProject(p.id)
  else useToasts.getState().show(`${p.name} is back`, 'success')
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
