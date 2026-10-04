// Where the caption vocabulary comes from: every project he has, read fresh at
// the start of each caption run. The learning itself is engine/captions/
// vocabulary.ts and is pure; this is the small dirty half that finds the clips.
//
// ⛔ EVERY PROJECT, NOT ONLY ARCHIVED ONES. The style learning beside it only
// reads a project when he archives it, and on 2026-10-03 not one of his saved
// projects was archived, so in practice it had learned nothing from any of
// them. This reads whatever is saved, finished or not, plus the edit he has
// open, so a fix counts the moment he makes it: the second time he corrects the
// same misspelling, in any video, the next caption run spells it his way.
//
// ⛔ AND IT CAN NEVER STOP A CAPTION RUN. Any failure here costs him the
// vocabulary for that run and nothing else: the run goes ahead as it always did.

import { correctionsFromClips, EMPTY_VOCABULARY, learnVocabulary, type ProjectCorrections, type Vocabulary } from '../engine/captions/vocabulary'
import type { Clip, Project } from '../engine/types'
import { listProjects, loadProjectById } from './persistence'
import { useStore } from './store'

const clipsOf = (p: Project): Clip[] => Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))

/** Read projects, keyed by id, so a run only re-reads what changed since the last one. */
const read = new Map<string, { updatedAt: number; corrections: ProjectCorrections | null }>()

/** What every caption he has corrected teaches, for the run about to start. */
export async function currentVocabulary(): Promise<Vocabulary> {
  try {
    const live = useStore.getState().project
    const all: ProjectCorrections[] = []
    for (const s of await listProjects()) {
      // The open edit is read live below: the saved copy can be a second behind.
      if (s.id === live.id) continue
      const hit = read.get(s.id)
      if (hit && hit.updatedAt === s.updatedAt) {
        if (hit.corrections) all.push(hit.corrections)
        continue
      }
      const p = await loadProjectById(s.id)
      const corrections = p ? correctionsFromClips(clipsOf(p)) : null
      read.set(s.id, { updatedAt: s.updatedAt, corrections })
      if (corrections) all.push(corrections)
    }
    const mine = correctionsFromClips(clipsOf(live))
    if (mine) all.push(mine)
    return learnVocabulary(all)
  } catch (err) {
    console.warn('OL Premiere captions: could not read the vocabulary, captioning without it', err)
    return EMPTY_VOCABULARY
  }
}
