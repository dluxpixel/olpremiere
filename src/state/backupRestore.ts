// Putting a backup back.
//
// ⛔ THE BACKUPS HAVE BEEN WRITTEN FAITHFULLY SINCE 2026-07-26 AND THERE WAS NO
// WAY TO GET ONE BACK. Every couple of minutes the whole edit went to a plain
// file on his disk, forty of them kept in rotation, and the only thing the app
// offered him was a button that opens the folder. So when he opened the editor
// on 2026-08-19 and his projects were not there, the honest state of things was
// that his work was two clicks away and no click existed. His words: *"every
// time you work on a new version, all my saved data gets deleted."* It was not
// deleted. It was unreachable, which felt exactly the same and cost the same.
//
// A restore NEVER overwrites. It lands as a new project with its own id, so
// recovering the wrong one costs nothing and he can try again. Whatever he had
// open stays exactly where it was.
//
// The media is not in a backup and does not need to be: an asset record holds
// the KEY of its bytes, not the bytes, and the bytes live in local storage which
// usually survives whatever took the project record. When some of it really is
// gone, this says which files to re-import by name rather than leaving him to
// work it out from a timeline full of black rectangles.

import { migrateProjectEffects } from '../engine/effects/migrate'
import { migrateProject, newId, type Project } from '../engine/types'
import type { BackupFile } from './autoBackup'
import { deleteProject, getBlob, listProjects, loadProjectById, saveProject } from './persistence'
import { openProject } from './projectActions'
import { doNotAutoRecover, markDoNotAutoRecover } from './recoveryMemory'
import { useToasts } from './toasts'

export interface BackupRow {
  /** Full path, and the only thing main will read back. */
  path: string
  name: string
  savedAtMs: number
  sizeBytes: number
}

/** What one backup file turns out to hold, once it has been read and parsed. */
export interface BackupContents {
  project: Project
  mediaNames: Record<string, string>
  clipCount: number
  assetCount: number
}

/** Every backup on disk, newest first. Empty when there is no desktop shell. */
export async function listBackups(): Promise<BackupRow[]> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.backupList) return []
  const rows = await api.backupList()
  return rows
    .map((r) => ({ path: r.path, name: r.name, savedAtMs: r.modifiedMs, sizeBytes: r.sizeBytes }))
    .sort((a, b) => b.savedAtMs - a.savedAtMs)
}

/**
 * Read one backup and say what is in it, WITHOUT changing anything.
 *
 * The counts are the whole point of the panel: forty files with near-identical
 * names tell him nothing, and "115 clips, 40 media" tells him which one is the
 * afternoon he does not want to lose.
 */
export async function readBackup(filePath: string): Promise<BackupContents | null> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.backupRead) return null
  let parsed: BackupFile
  try {
    parsed = JSON.parse(await api.backupRead(filePath)) as BackupFile
  } catch {
    return null
  }
  const raw = parsed?.project
  if (!raw || typeof raw !== 'object') return null
  // The same two migrations a project gets when it is loaded from storage. A
  // backup can be weeks old, so it arrives in whatever shape that version wrote.
  const project = migrateProjectEffects(migrateProject(raw))
  const clipCount = Object.values(project.sequences ?? {}).reduce(
    (n, sq) => n + sq.tracks.reduce((m, t) => m + t.clips.length, 0),
    0,
  )
  return {
    project,
    mediaNames: parsed.mediaNames ?? {},
    clipCount,
    assetCount: Object.keys(project.assets ?? {}).length,
  }
}

/** How many of this project's assets still have their bytes in local storage. */
async function countLiveMedia(project: Project): Promise<{ have: number; missing: string[] }> {
  const assets = Object.values(project.assets ?? {})
  let have = 0
  const missing: string[] = []
  for (const a of assets) {
    if (!a?.blobKey) continue
    // Title and adjustment clips carry no media, so they are not counted either way.
    if (await getBlob(a.blobKey)) have += 1
    else missing.push(a.name ?? a.blobKey)
  }
  return { have, missing }
}

/**
 * Put a backup back as a NEW project and open it.
 *
 * A fresh id, and a fresh id for every sequence too, because the ids in the file
 * may still be in use by something he has open. Two projects sharing a sequence
 * id would have them saving over each other, which is a worse bug than the one
 * being recovered from.
 */
async function landRestored(project: Project): Promise<Project | null> {
  const sequenceIdMap = new Map<string, string>()
  const sequences: Project['sequences'] = {}
  for (const [oldId, sq] of Object.entries(project.sequences ?? {})) {
    const freshId = newId()
    sequenceIdMap.set(oldId, freshId)
    sequences[freshId] = { ...sq, id: freshId }
  }
  const activeSequenceId =
    sequenceIdMap.get(project.activeSequenceId) ?? Object.keys(sequences)[0] ?? project.activeSequenceId

  const restored: Project = {
    ...project,
    id: newId(),
    name: `${project.name ?? 'Untitled Project'} (recovered)`,
    sequences,
    activeSequenceId,
    createdAt: project.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  // Recovering something he had filed away should not file the recovery away too.
  delete restored.archivedAt
  delete restored.laterAt

  try {
    await saveProject(restored)
  } catch (err) {
    console.error('OL Premiere: could not save the restored project', err)
    useToasts.getState().show('The recovered project could not be saved', 'danger')
    return null
  }
  return restored
}

export async function restoreBackup(filePath: string): Promise<boolean> {
  const contents = await readBackup(filePath)
  if (!contents) {
    useToasts.getState().show('That backup could not be read', 'danger')
    return false
  }
  const restored = await landRestored(contents.project)
  if (!restored) return false

  await openProject(restored.id)

  const { missing } = await countLiveMedia(restored)
  if (missing.length === 0) {
    useToasts.getState().show(`Recovered ${contents.clipCount} clips`, 'success')
  } else {
    // Naming the files is the difference between a fixable problem and a mystery.
    const head = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
    useToasts
      .getState()
      .show(`Recovered the edit. ${missing.length} media files need importing again: ${head}${rest}`, 'info', undefined, {
        durationMs: 15_000,
      })
  }
  return true
}

// --- Opening blank when copies exist -----------------------------------------
//
// ⛔ THE APP MUST NEVER OPEN EMPTY WHILE HIS WORK IS SITTING ON THE DISK.
//
// 2026-08-19, the evening this was written. His editor opened with an empty
// project list. The store had been rebuilt underneath the app: the browser
// engine's database was thrown away and started again from nothing, which is a
// thing it does on its own when it decides the files are unreadable, and no code
// in this app can stop it or be told about it. What survived is what always
// survives, the plain backup files, and forty of them were on his disk holding
// an edit of a hundred and eighteen clips.
//
// The old integrity check had a hole exactly the shape of that night: it treated
// an empty store as a NEW INSTALL and said nothing. An install with forty
// backups behind it is not new. It has been wiped, and the difference is the
// whole thing.
//
// So: nothing in storage, backups on the disk, put the newest one back before he
// ever sees the empty shelf. It costs a second and it turns the worst moment the
// app has into something he never notices happened.

/** What was brought back, for the sentence he reads. */
export interface WipeRecovery {
  /** The biggest edit that came back, which is the one he is looking for. */
  name: string
  clipCount: number
  assetCount: number
  /** How many projects were put back in total. */
  projectCount: number
}

/** Never put back more than this in one go, whatever the folder holds. */
const MAX_RECOVERED = 12

/**
 * Bring back everything the wipe took, when storage came up with nothing in it.
 *
 * ⛔ EVERY PROJECT, NOT THE NEWEST FILE. A wipe does not take one project, it
 * takes the store, so restoring only the most recent backup would hand him back
 * whatever he happened to touch last and quietly leave the rest gone. On the
 * night this was written the newest real file held a three clip test and the
 * edit he actually wanted, a hundred and eighteen clips, was two files further
 * down. So the folder is grouped by the id inside each file and the NEWEST file
 * of each project is put back, which is the same set the store held.
 *
 * Returns null in every case where the app should stay out of the way: he has
 * work, there are no backups, the backups hold nothing, or these projects have
 * been handed back once already.
 *
 * The emptiness test is deliberately about CONTENT rather than count. Boot
 * creates a blank Untitled Project and the autosave writes it within a second,
 * so by the time this runs a wiped store usually holds exactly one project with
 * nothing in it. Counting rows would call that "not empty" and stay silent,
 * which is the same silence that cost him the evening.
 */
/**
 * Clear away recovered projects that turned out to be nothing but a name.
 *
 * ⛔ THIS IS CLEANING UP AFTER MYSELF, NOT A FEATURE. On 2026-08-22 the recovery
 * put six rows on his shelf, five of them caption harness projects whose media
 * have never existed in his store, and it opened one of them over his own edit.
 * The rule that stops it happening again is in `recoverFromWipe`; this is for the
 * ones already sitting there, because leaving him to bin them by hand is handing
 * him my mistake as a chore.
 *
 * ⛔ AND IT IS DELIBERATELY THE NARROWEST SWEEP THAT DOES THE JOB. All four must
 * hold, and each one is there to stop it eating something real:
 *  - the name ends in "(recovered)", so only the automatic restore's own output
 *    is ever in scope
 *  - it HAS assets and NONE of their bytes exist, so there is nothing to open
 *  - `updatedAt` equals `createdAt`, so he has never touched it since it landed
 *  - it is not the project currently open
 *
 * ⚠️ A real edit of his whose media were ALSO lost would match the first three,
 * and deleting it would cost him the edit while leaving the useless media. That
 * is why the store's own backups are untouched by this and why the fourth guard
 * exists. It cannot fire on anything he has opened, named or edited.
 */
export async function sweepEmptyRecoveries(openId: string | null): Promise<number> {
  const summaries = await listProjects()
  let gone = 0
  for (const s of summaries) {
    if (s.id === openId) continue
    if (!s.name?.endsWith('(recovered)')) continue
    if (s.assetCount === 0) continue
    if (s.updatedAt !== s.createdAt) continue
    const project = await loadProjectById(s.id)
    if (!project) continue
    const { have } = await countLiveMedia(project)
    if (have > 0) continue
    await deleteProject(s.id)
    gone += 1
  }
  if (gone > 0) {
    useToasts
      .getState()
      .show(
        `Cleared ${gone} recovered ${gone === 1 ? 'project that had' : 'projects that had'} no media left`,
        'info',
        undefined,
        { durationMs: 8000 },
      )
  }
  return gone
}

export async function recoverFromWipe(
  projects: readonly { clipCount: number; assetCount: number }[],
): Promise<WipeRecovery | null> {
  if (projects.some((p) => p.clipCount > 0 || p.assetCount > 0)) return null

  const rows = await listBackups()
  if (rows.length === 0) return null

  // Newest first, so the first file seen for an id is the newest one it has.
  const done = doNotAutoRecover()
  const newestOf = new Map<string, BackupContents>()
  for (const row of rows) {
    const contents = await readBackup(row.path)
    // Skip the blank ones. A wiped app writes its own empty project to a backup
    // too, and handing that back would be theatre.
    if (!contents || contents.clipCount === 0) continue
    const id = contents.project.id
    if (!id || done.has(id) || newestOf.has(id)) continue
    newestOf.set(id, contents)
    if (newestOf.size >= MAX_RECOVERED) break
  }
  if (newestOf.size === 0) return null

  // ⛔ A PROJECT WHOSE MEDIA ARE ALL GONE IS NOT RECOVERY, IT IS LITTER.
  //
  // FOUND ON HIS SCREEN, 2026-08-22. He opened the app and got SIX rows all
  // called "Untitled Project (recovered)", and the one that opened was a wall of
  // `9-music-only-rigid-60s.wav` and `1-speech-...`: caption HARNESS fixtures,
  // which a test run had written into his backups folder before that was fixed.
  // Their media were imported into a throwaway profile and have never existed in
  // his store, so every one of them came back as a named shell he cannot play,
  // cannot export, and did not ask for.
  //
  // Some missing media is still worth restoring, because the edit is the part
  // that took him hours and the files can be imported again. NONE alive is a
  // different thing entirely: there is no edit left to rescue, only a name.
  const alive = new Map<BackupContents, number>()
  const keep: BackupContents[] = []
  for (const contents of newestOf.values()) {
    const { have } = await countLiveMedia(contents.project)
    const wanted = Object.values(contents.project.assets ?? {}).filter((a) => a?.blobKey).length
    if (wanted > 0 && have === 0) continue
    alive.set(contents, have)
    keep.push(contents)
  }
  if (keep.length === 0) return null

  // Said BEFORE anything lands, and said plainly. Work reappearing on its own is
  // only reassuring if he knows why it went and why it is back; unexplained is
  // exactly how the app felt on the night this was written.
  // ⛔ AND IT COUNTS WHAT WILL ACTUALLY COME BACK, not what was found. Saying six
  // and landing one is worse than saying nothing.
  const n = keep.length
  useToasts
    .getState()
    .show(
      `Your ${n === 1 ? 'project was' : `${n} projects were`} missing when the app opened, so the latest backup${n === 1 ? '' : 's'} came back`,
      'info',
      undefined,
      { durationMs: 12_000 },
    )

  // ⛔ AND THE ONE LEFT OPEN IS THE ONE THAT MOST NEARLY WORKS, NOT THE LONGEST.
  // This used to sort on clip count alone, which is why a 122 clip harness
  // timeline opened over his own 44 clip edit. Live media first, clips only to
  // break a tie.
  const ordered = [...keep].sort((a, b) => (alive.get(a)! - alive.get(b)!) || a.clipCount - b.clipCount)
  const landed: { project: Project; contents: BackupContents }[] = []
  for (const contents of ordered) {
    const project = await landRestored(contents.project)
    if (project) landed.push({ project, contents })
  }
  if (landed.length === 0) return null
  markDoNotAutoRecover(landed.map((l) => l.contents.project.id))

  const biggest = landed[landed.length - 1]
  await openProject(biggest.project.id)

  const { missing } = await countLiveMedia(biggest.project)
  if (missing.length > 0) {
    // Naming the files is the difference between a fixable problem and a mystery.
    const head = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
    useToasts
      .getState()
      .show(`${missing.length} media files need importing again: ${head}${rest}`, 'info', undefined, {
        durationMs: 15_000,
      })
  }

  return {
    name: biggest.contents.project.name ?? 'Untitled Project',
    clipCount: biggest.contents.clipCount,
    assetCount: biggest.contents.assetCount,
    projectCount: landed.length,
  }
}
