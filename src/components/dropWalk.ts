// What a drop from Explorer really contains, folders opened.
//
// A folder dragged onto the window arrives in `dataTransfer.files` as one
// File with no type, which the importer then called unsupported: the most
// natural way to bring a whole shoot in, dragging the folder, ended in a red
// toast and an empty bin. The entries API sees the folder for what it is and
// lets it be walked. The walk is done in two halves because the DataTransfer
// is only readable DURING the drop event: `entriesOf` grabs the entries
// synchronously, `filesOf` reads them afterwards.

/** The subset of FileSystemEntry this needs, so a test can hand in fakes. */
export interface DropEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (list: DropEntry[]) => void, fail?: (e: unknown) => void) => void }
}

/** Synchronous half: the entries behind the items, or the plain files when the browser has no entries. */
export function entriesOf(dt: DataTransfer | null): { entries: DropEntry[]; files: File[] } {
  if (!dt) return { entries: [], files: [] }
  const entries: DropEntry[] = []
  const items = dt.items ? Array.from(dt.items) : []
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => DropEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  return entries.length > 0 ? { entries, files: [] } : { entries: [], files: Array.from(dt.files ?? []) }
}

const readAll = (entry: DropEntry): Promise<DropEntry[]> =>
  new Promise((resolve) => {
    const reader = entry.createReader?.()
    if (!reader) return resolve([])
    const out: DropEntry[] = []
    // readEntries hands back a page at a time and an empty page at the end.
    const step = (): void =>
      reader.readEntries(
        (list) => {
          if (list.length === 0) return resolve(out)
          out.push(...list)
          step()
        },
        () => resolve(out),
      )
    step()
  })

const fileOf = (entry: DropEntry): Promise<File | null> =>
  new Promise((resolve) => (entry.file ? entry.file(resolve, () => resolve(null)) : resolve(null)))

/**
 * Asynchronous half: every file under the entries, folders walked in full,
 * hidden files (a leading dot, and Windows' desktop.ini and Thumbs.db) left out.
 */
export async function filesOf(entries: readonly DropEntry[]): Promise<File[]> {
  const out: File[] = []
  const skip = (name: string): boolean => name.startsWith('.') || /^(desktop\.ini|thumbs\.db)$/i.test(name)
  const walk = async (entry: DropEntry): Promise<void> => {
    if (skip(entry.name)) return
    if (entry.isFile) {
      const f = await fileOf(entry)
      if (f) out.push(f)
      return
    }
    if (entry.isDirectory) for (const child of await readAll(entry)) await walk(child)
  }
  for (const e of entries) await walk(e)
  return out
}
