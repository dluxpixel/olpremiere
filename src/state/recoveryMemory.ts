// The short list of projects the app must never hand back on its own.
//
// Its own file, and not part of either side, because both sides need it and they
// already point at each other: the recovery reads storage, and storage has to be
// able to say "he threw that one away" without importing the recovery back.
//
// Two things land here:
//
//   - anything the automatic recovery has already put back, so throwing away a
//     recovery he did not want is respected rather than undone on the next boot
//   - anything he DELETED himself, because a wipe and a clear-out look identical
//     from the outside, and an app that resurrects work he deliberately binned is
//     not being helpful, it is arguing with him
//
// Keyed on the project id, which is the same id in storage and in the backup
// file, so one project's forty backups are one entry.

const KEY = 'olp.doNotAutoRecover'

/** Project ids the automatic recovery must leave alone. */
export function doNotAutoRecover(): Set<string> {
  try {
    const raw = window.localStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    // Private mode or a blocked store: at worst he is offered a recovery twice.
    return new Set()
  }
}

/** Add ids to the list. Cheap, and safe to call with ids already on it. */
export function markDoNotAutoRecover(ids: Iterable<string>): void {
  try {
    const all = doNotAutoRecover()
    for (const id of ids) all.add(id)
    window.localStorage.setItem(KEY, JSON.stringify([...all]))
  } catch {
    // As above: this list is a courtesy, never a correctness requirement.
  }
}
