// "Import reel plan...": the entry point of the gym auto edit (phase 1).
//
// The plan is checked in main (electron/reelPlanFile.ts); a plan with ANY problem comes
// back refused and nothing here runs. A good plan becomes a NEW project in a new tab,
// the way New project does it: the open edit autosaves and stays in its tab, it is never
// overwritten. Its clips come in through the app's own media import, so thumbnails, the
// disk mirror, HDR and remux handling are the ones every import gets. The layout is the
// mapper's (reelPlanProject.ts). It is saved by the app's own save, and this file writes
// no project format of its own.

import type { OlApi, ReelPlanClipFile } from '../../electron/ipc-types'
import type { ReelPlan } from '../../electron/reelPlan'
import { nextFreeName } from '../engine/uniqueName'
import type { MediaAsset } from '../engine/types'
import { flushOutgoing, guardRoom, switchTo } from './editTabs'
import { importFiles, useImportProgress } from './mediaActions'
import { listProjects } from './persistence'
import { discardProject } from './projectActions'
import {
  applyReelPlanToProject,
  newReelPlanProject,
  reelPlanProjectName,
  reelPlanRefusalMessage,
} from './reelPlanProject'
import { useStore } from './store'
import { useToasts } from './toasts'

/** How much of a clip main hands over per call; the same size the remux stream uses. */
const CHUNK = 8 * 1024 * 1024

/** A clip of the approved plan, read from main in pieces into one File. */
async function readClipFile(api: OlApi, f: ReelPlanClipFile): Promise<File> {
  const parts: Blob[] = []
  for (let offset = 0; offset < f.size; offset += CHUNK) {
    const length = Math.min(CHUNK, f.size - offset)
    // Each piece becomes a Blob at once, so the browser can keep it off the heap.
    parts.push(new Blob([await api.reelPlanReadClip(f.id, offset, length)]))
  }
  return new File(parts, f.name, { type: f.mime })
}

let running = false

/**
 * Throw away the project this import made, when the import cannot finish. Back to the
 * edit he was in first, then the half built one is deleted outright: no Undo toast, no
 * Projects row, no media left in the store. It is not one of his projects, so it does not
 * go through the delete he can take back. False when it could not be done (the way back
 * was refused, or the delete failed), and the half built project is then still there.
 */
async function discardHalfBuilt(createdId: string, previousId: string): Promise<boolean> {
  try {
    if ((await switchTo(previousId)) !== 'ok') return false
    await discardProject(createdId)
    return true
  } catch (err) {
    console.error('OL Premiere: the half built reel project could not be removed', err)
    return false
  }
}

/**
 * Ask for a reel plan, check it, and open it as a new project. Says what happened in
 * a toast either way; resolves when it is done.
 */
export async function importReelPlan(): Promise<void> {
  const show = useToasts.getState().show
  const api = window.api
  if (!api) {
    show('Importing a reel plan needs the desktop app', 'info')
    return
  }
  // A second click while the first is still reading clips would open a second project.
  if (running) return
  if (!guardRoom()) return
  running = true
  let createdId: string | null = null
  let previousId = ''
  try {
    const answer = await api.reelPlanImport()
    if (answer.status === 'cancelled') return
    if (answer.status === 'refused') {
      console.error('OL Premiere: the reel plan was refused', answer.problems)
      show(reelPlanRefusalMessage(answer.problems), 'danger')
      return
    }
    const { plan, files, fileName } = answer

    // The new project first: if the open edit cannot be put away (a collab room, a save
    // that failed, media still coming in) this says so BEFORE any clip is read.
    let taken = new Set<string>()
    try {
      taken = new Set((await listProjects()).map((s) => s.name))
    } catch {
      // Unknown names only cost the plain name, never the import.
    }
    taken.add(useStore.getState().project.name)
    const project = newReelPlanProject(plan, nextFreeName(reelPlanProjectName(fileName), taken))
    previousId = useStore.getState().project.id
    if ((await switchTo(project)) !== 'ok') return
    createdId = project.id

    // Reading holds the import flag, so the edit cannot be left while its clips arrive.
    const clipFiles: File[] = []
    try {
      for (const [i, f] of files.entries()) {
        useImportProgress.setState({ total: files.length, done: i, name: f.name, step: 'Reading', frac: 0 })
        clipFiles.push(await readClipFile(api, f))
      }
    } catch (err) {
      useImportProgress.setState({ total: 0, done: 0, name: '', step: '', frac: 0 })
      throw err
    }

    // Quiet: "done" is said once, after the build, never before it.
    const ids = await importFiles(clipFiles, { quiet: true })
    // The whole plan or nothing: a clip that did not come in (importFiles has said which)
    // would leave a hole in the edit, so the half built project goes.
    if (ids.length !== files.length) {
      const gone = await discardHalfBuilt(project.id, previousId)
      createdId = null
      show(
        gone
          ? 'A clip of the reel plan could not be imported, so no project was made'
          : 'A clip of the reel plan could not be imported, and the half built project is still open',
        'danger',
      )
      return
    }

    const live = useStore.getState().project
    if (live.id !== project.id) throw new Error('the new project is no longer the open edit')
    const assets: Record<string, MediaAsset> = {}
    files.forEach((f, i) => {
      assets[f.id] = live.assets[ids[i]]
    })
    const warnings: string[] = []
    useStore.getState().dispatch('Import reel plan', (p) => {
      const built = applyReelPlanToProject(p, plan, assets)
      warnings.push(...built.warnings)
      return built.project
    })
    // Written the app's normal way (the database and the project file), now.
    if (!(await flushOutgoing(true))) return
    createdId = null
    describeResult(plan, project.name, warnings)
  } catch (err) {
    console.error('OL Premiere: the reel plan could not be imported', err)
    const gone = createdId === null || (await discardHalfBuilt(createdId, previousId))
    show(
      gone
        ? 'The reel plan could not be imported. No project was made'
        : 'The reel plan could not be imported, and the half built project is still open',
      'danger',
    )
  } finally {
    running = false
  }
}

function describeResult(plan: ReelPlan, name: string, warnings: string[]): void {
  const show = useToasts.getState().show
  for (const w of warnings) console.warn('OL Premiere: reel plan:', w)
  const shots = plan.timeline.length
  show(
    warnings.length > 0
      ? `Built “${name}” from the reel plan. ${warnings[0]}${warnings.length > 1 ? ` And ${warnings.length - 1} more.` : ''}`
      : `Built “${name}” from the reel plan: ${shots} ${shots === 1 ? 'shot' : 'shots'}`,
    warnings.length > 0 ? 'info' : 'success',
  )
}
