// The release flow against a FAKE GitHub. On 2026-10-04 v3.22.0 was visible on
// GitHub, tagged and published, while its 142 MB installer was still uploading, and
// latest.yml (the file the updater reads) is the last one up. Every copy of the app
// that checked in that window got a 404 and a wall of headers. The fix is that a
// release stays a DRAFT until every file is on it, and the part worth proving is
// the part that never runs outside a real ship: what is public at each moment, and
// what a half finished run leaves behind.
//
// The fake sits at the fetch level, so the real `githubApi` (its headers, its error
// text) and the real `publishRelease` run unchanged. Only the raw curl upload is
// replaced, because that is the one thing that cannot run without a network.

import { describe, expect, it } from 'vitest'
import { githubApi, publishRelease, uploadAsset } from './githubRelease.mjs'

const REPO = '/repos/dluxpixel/olpremiere'
const TAG = 'v3.22.0'
const EXE = 'OL-Premiere-3.22.0-setup.exe'
const MAP = `${EXE}.blockmap`
const ASSETS = [
  { name: EXE, file: 'C:/out/exe', type: 'application/octet-stream', bytes: 142_000_000 },
  { name: MAP, file: 'C:/out/map', type: 'application/octet-stream', bytes: 150_000 },
  { name: 'latest.yml', file: 'C:/out/yml', type: 'text/yaml', bytes: 380 },
]

/** curl's exit code for "send error", the one this machine really produces. */
const curlFail = (status = 55) => Object.assign(new Error(`curl exited ${status}`), { status })

/**
 * An in-memory GitHub. `public` is what the world can see: a release that is not a
 * draft. `events` is every call in order, so a test can say what happened before
 * what. `snapshots` records, at the instant a release goes public, which assets it
 * had, which is the question that matters.
 */
function fakeGitHub({ ignoreDraft = false, failPatch = false, strayAsset = false, patchLost = false, offlineAfterPatch = false } = {}) {
  const gh = {
    releases: [],
    assets: new Map(), // releaseId -> [{ id, name, state, size }]
    refs: new Set(),
    events: [],
    snapshots: [],
    createBodies: [],
    nextId: 100,
  }
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })
  const withAssets = (r) => ({ ...r, assets: [...(gh.assets.get(r.id) ?? [])] })

  /** What fetch itself throws when the connection dies: no status, no answer. */
  const connectionLost = () => new TypeError('fetch failed')
  let patched = false
  gh.fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const path = new URL(url).pathname.slice(REPO.length)
    gh.events.push(`${method} ${path}`)
    if (offlineAfterPatch && patched) throw connectionLost()
    let m
    if (method === 'GET' && path === '/releases') return json(200, gh.releases.map(withAssets))
    if (method === 'DELETE' && (m = /^\/releases\/(\d+)$/.exec(path))) {
      gh.releases = gh.releases.filter((r) => r.id !== Number(m[1]))
      gh.assets.delete(Number(m[1]))
      return json(204)
    }
    if (method === 'DELETE' && (m = /^\/git\/refs\/tags\/(.+)$/.exec(path))) {
      return gh.refs.delete(m[1]) ? json(204) : json(422, { message: 'Reference does not exist' })
    }
    if (method === 'GET' && path === '/git/ref/heads/main') return json(200, { object: { sha: 'abc123' } })
    if (method === 'POST' && path === '/git/refs') {
      const ref = JSON.parse(opts.body).ref.replace('refs/tags/', '')
      if (gh.refs.has(ref)) return json(422, { message: 'Reference already exists' })
      gh.refs.add(ref)
      return json(201, {})
    }
    if (method === 'POST' && path === '/releases') {
      const body = JSON.parse(opts.body)
      gh.createBodies.push(body)
      const r = { id: gh.nextId++, tag_name: body.tag_name, draft: ignoreDraft ? false : !!body.draft }
      gh.releases.push(r)
      gh.assets.set(r.id, strayAsset ? [{ id: gh.nextId++, name: 'stray.txt', state: 'uploaded', size: 1 }] : [])
      return json(201, r)
    }
    if (method === 'GET' && (m = /^\/releases\/(\d+)\/assets/.exec(path))) return json(200, gh.assets.get(Number(m[1])) ?? [])
    if (method === 'DELETE' && (m = /^\/releases\/assets\/(\d+)$/.exec(path))) {
      for (const [id, list] of gh.assets) gh.assets.set(id, list.filter((a) => a.id !== Number(m[1])))
      return json(204)
    }
    if (method === 'PATCH' && (m = /^\/releases\/(\d+)$/.exec(path))) {
      if (failPatch) return json(500, { message: 'Server Error' })
      const r = gh.releases.find((x) => x.id === Number(m[1]))
      Object.assign(r, { draft: JSON.parse(opts.body).draft })
      if (!r.draft) gh.snapshots.push((gh.assets.get(r.id) ?? []).map((a) => ({ name: a.name, size: a.size, state: a.state })))
      patched = true
      // Applied on GitHub's side, and then the answer never arrives.
      if (patchLost) throw connectionLost()
      return json(200, withAssets(r))
    }
    if (method === 'GET' && (m = /^\/releases\/(\d+)$/.exec(path))) {
      return json(200, withAssets(gh.releases.find((x) => x.id === Number(m[1]))))
    }
    return json(404, { message: `fake GitHub has no ${method} ${path}` })
  }

  /** What the world sees: published releases only. */
  gh.public = () => gh.releases.filter((r) => !r.draft)
  /** Put an asset on a release the way a finished upload does. */
  gh.land = (releaseId, name, size, state = 'uploaded') => {
    const list = gh.assets.get(releaseId) ?? []
    gh.assets.set(releaseId, [...list.filter((a) => a.name !== name), { id: gh.nextId++, name, state, size }])
  }
  return gh
}

/**
 * The raw upload, in the shapes it really takes. `script` maps an asset name to a
 * list of outcomes, one per attempt: 'ok', 'fail' (curl dies, nothing stored),
 * 'ok-but-curl-died' (stored complete, curl still exits 55: the 2026-08-13 scar),
 * or 'partial' (half of it arrives).
 */
function fakeUpload(gh, script = {}) {
  const attempts = {}
  const post = async ({ releaseId, name }) => {
    const rel = gh.releases.find((r) => r.id === releaseId)
    // ⛔ THE POINT OF THE WHOLE CHANGE: a file only ever arrives on a draft.
    gh.events.push(`upload ${name} (release is ${rel.draft ? 'a draft' : 'PUBLIC'})`)
    attempts[name] = (attempts[name] ?? 0) + 1
    const outcome = (script[name] ?? [])[attempts[name] - 1] ?? 'ok'
    const want = ASSETS.find((a) => a.name === name).bytes
    if (outcome === 'fail') throw curlFail()
    if (outcome === 'partial') {
      gh.land(releaseId, name, Math.floor(want / 2), 'starter')
      throw curlFail()
    }
    gh.land(releaseId, name, want)
    if (outcome === 'ok-but-curl-died') throw curlFail()
  }
  post.attempts = attempts
  return post
}

const quiet = () => {
  const lines = []
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(`WARN ${a.join(' ')}`) }
}

/** Run one ship against `gh`. Returns what a caller would see. */
function ship(gh, { post = fakeUpload(gh), tagLocal = () => {}, uploadTries = 3 } = {}) {
  const out = quiet()
  const tagged = []
  const promise = publishRelease({
    api: githubApi({ token: 't', fetchImpl: gh.fetchImpl }),
    repoPath: REPO,
    tag: TAG,
    assets: ASSETS,
    postAsset: post,
    tagLocal: (t) => {
      tagged.push(t)
      tagLocal(t)
    },
    uploadTries,
    ...out,
  })
  return { promise, out, tagged, post }
}

describe('a ship that works', () => {
  it('creates a DRAFT, uploads everything onto it, and only then publishes', async () => {
    const gh = fakeGitHub()
    const { promise, out } = ship(gh)
    const rel = await promise

    expect(gh.createBodies).toHaveLength(1)
    expect(gh.createBodies[0]).toMatchObject({ tag_name: TAG, draft: true })
    // A draft cannot be the latest, so the request must not ask for it.
    expect(gh.createBodies[0]).not.toHaveProperty('make_latest')

    // Every upload went into a draft, never into something the updater could see.
    const uploads = gh.events.filter((e) => e.startsWith('upload '))
    expect(uploads).toHaveLength(3)
    for (const u of uploads) expect(u).toContain('release is a draft')

    expect(rel.draft).toBe(false)
    expect(gh.public()).toHaveLength(1)
    expect(out.lines.join('\n')).toContain(`Published ${TAG} (draft=false)`)
  })

  it('⛔ is not public until all three files are on it at their real size', async () => {
    const gh = fakeGitHub()
    await (ship(gh)).promise
    // Exactly one moment of going public, and the release held the full set then.
    expect(gh.snapshots).toHaveLength(1)
    expect(gh.snapshots[0]).toEqual(
      ASSETS.map((a) => ({ name: a.name, size: a.bytes, state: 'uploaded' })),
    )
    // And nothing was published before the last upload: the order of events says so.
    const lastUpload = gh.events.map((e, i) => (e.startsWith('upload ') ? i : -1)).reduce((a, b) => Math.max(a, b))
    const flip = gh.events.findIndex((e) => e.startsWith('PATCH /releases/'))
    expect(flip).toBeGreaterThan(lastUpload)
  })

  it('puts latest.yml last, the file the updater reads', async () => {
    const gh = fakeGitHub()
    await (ship(gh)).promise
    const order = gh.events.filter((e) => e.startsWith('upload ')).map((e) => e.split(' ')[1])
    expect(order).toEqual([EXE, MAP, 'latest.yml'])
  })

  it('still tags main through the API and in the local clone, as it always did', async () => {
    const gh = fakeGitHub()
    const { promise, tagged } = ship(gh)
    await promise
    expect([...gh.refs]).toEqual([TAG])
    expect(tagged).toEqual([TAG])
    // The tag is pushed before the release exists, so the release points at it.
    expect(gh.events.indexOf('POST /git/refs')).toBeLessThan(gh.events.indexOf('POST /releases'))
  })

  it('a clone that will not take the tag does not fail the release', async () => {
    const gh = fakeGitHub()
    const { promise, out } = ship(gh, {
      tagLocal: () => {
        throw new Error('fatal: not a git repository')
      },
    })
    await expect(promise).resolves.toMatchObject({ draft: false })
    expect(out.lines.some((l) => l.startsWith('WARN could not write the local tag'))).toBe(true)
  })

  it('believes GitHub over curl when curl died but the file landed whole', async () => {
    const gh = fakeGitHub()
    const { promise, out } = ship(gh, { post: fakeUpload(gh, { [EXE]: ['ok-but-curl-died'] }) })
    await expect(promise).resolves.toMatchObject({ draft: false })
    expect(out.lines.join('\n')).toContain('Believing GitHub')
  })

  it('removes a half uploaded file and sends it again', async () => {
    const gh = fakeGitHub()
    const run = ship(gh, { post: fakeUpload(gh, { [EXE]: ['partial'] }) })
    await expect(run.promise).resolves.toMatchObject({ draft: false })
    expect(run.out.lines.join('\n')).toMatch(/starter at 71000000\/142000000 bytes, removing and retrying/)
    // What went public is the whole installer, not the half that arrived first.
    expect(gh.snapshots[0].find((a) => a.name === EXE)).toMatchObject({ size: 142_000_000, state: 'uploaded' })
  })
})

describe('a ship that fails part way', () => {
  it('⛔ an upload that never lands leaves a DRAFT, nothing public, and says so loudly', async () => {
    const gh = fakeGitHub()
    // The installer and blockmap go up fine; latest.yml dies on every attempt.
    const run = ship(gh, { post: fakeUpload(gh, { 'latest.yml': ['fail', 'fail', 'fail'] }) })
    const err = await run.promise.catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('was NOT published and is still a draft')
    expect(err.message).toContain('latest.yml did not upload after 3 attempts')

    // The world sees nothing: no published release, and the publish call never ran.
    expect(gh.public()).toHaveLength(0)
    expect(gh.releases).toHaveLength(1)
    expect(gh.releases[0].draft).toBe(true)
    expect(gh.snapshots).toHaveLength(0)
    expect(gh.events.some((e) => e.startsWith('PATCH '))).toBe(false)
    // The files that did arrive are sitting on the draft, the tag was pushed.
    expect(gh.assets.get(gh.releases[0].id).map((a) => a.name).sort()).toEqual([EXE, MAP].sort())
    expect([...gh.refs]).toEqual([TAG])
  })

  it('failing on the very first file attempts nothing after it', async () => {
    const gh = fakeGitHub()
    const post = fakeUpload(gh, { [EXE]: ['fail', 'fail', 'fail'] })
    const run = ship(gh, { post })
    await expect(run.promise).rejects.toThrow(/still a draft/)
    expect(post.attempts).toEqual({ [EXE]: 3 })
    expect(gh.public()).toHaveLength(0)
  })

  it('a file that arrives at the wrong size every time never goes public', async () => {
    const gh = fakeGitHub()
    const run = ship(gh, { post: fakeUpload(gh, { [MAP]: ['partial', 'partial', 'partial'] }) })
    await expect(run.promise).rejects.toThrow(/still a draft/)
    expect(gh.public()).toHaveLength(0)
    expect(gh.snapshots).toHaveLength(0)
  })

  it('a stray extra file on the draft stops it, the count is checked as well as the names', async () => {
    const gh = fakeGitHub({ strayAsset: true })
    const run = ship(gh)
    const err = await run.promise.catch((e) => e)
    expect(err.message).toContain('expected 3 assets')
    expect(err.message).toContain('stray.txt')
    expect(gh.public()).toHaveLength(0)
  })

  it('a publish call that GitHub refuses leaves the draft, with every file already on it', async () => {
    const gh = fakeGitHub({ failPatch: true })
    const run = ship(gh)
    const err = await run.promise.catch((e) => e)
    expect(err.message).toContain('still a draft')
    expect(err.message).toContain('GitHub 500')
    expect(gh.public()).toHaveLength(0)
    expect(gh.assets.get(gh.releases[0].id)).toHaveLength(3)
  })

  it('⛔ a publish GitHub applied but whose answer was lost is published, not "NOT published"', async () => {
    const gh = fakeGitHub({ patchLost: true })
    const run = ship(gh)
    const rel = await run.promise
    expect(rel.draft).toBe(false)
    expect(gh.public()).toHaveLength(1)
    expect(run.out.lines.join('\n')).toContain(`GitHub shows ${TAG} published`)
  })

  it('when GitHub cannot be asked either, it says the release may be live, never that it is not', async () => {
    const gh = fakeGitHub({ patchLost: true, offlineAfterPatch: true })
    const err = await ship(gh).promise.catch((e) => e)
    expect(err.message).toContain('MAY ALREADY BE PUBLISHED')
    expect(err.message).not.toContain('NOT published')
    expect(gh.public()).toHaveLength(1)
  })

  it('stops before uploading anything if GitHub hands back a release that is not a draft', async () => {
    const gh = fakeGitHub({ ignoreDraft: true })
    const post = fakeUpload(gh)
    const run = ship(gh, { post })
    await expect(run.promise).rejects.toThrow(/created PUBLISHED instead of as a draft/)
    expect(post.attempts).toEqual({})
  })
})

describe('a retry', () => {
  it('⛔ running the ship again after a failure clears the leftover draft and publishes cleanly', async () => {
    const gh = fakeGitHub()
    const first = ship(gh, { post: fakeUpload(gh, { 'latest.yml': ['fail', 'fail', 'fail'] }) })
    await expect(first.promise).rejects.toThrow(/still a draft/)
    const leftover = gh.releases[0].id

    // Same fake GitHub, same state, a working network this time.
    const second = ship(gh)
    const rel = await second.promise

    expect(rel.draft).toBe(false)
    expect(second.out.lines.join('\n')).toContain(`Replacing existing ${TAG} (id ${leftover}, a draft an earlier run left)`)
    // One release, the new one, published, with exactly the three files.
    expect(gh.releases).toHaveLength(1)
    expect(gh.releases[0].id).not.toBe(leftover)
    expect(gh.public()).toHaveLength(1)
    expect(gh.assets.get(gh.releases[0].id).map((a) => a.name).sort()).toEqual([EXE, MAP, 'latest.yml'].sort())
    // The old tag was cleared and made again, not left to collide (GitHub 422s a duplicate).
    expect([...gh.refs]).toEqual([TAG])
  })

  it('a retry inside one upload succeeds on the second try and the ship goes through', async () => {
    const gh = fakeGitHub()
    const post = fakeUpload(gh, { 'latest.yml': ['fail'] })
    const run = ship(gh, { post })
    await expect(run.promise).resolves.toMatchObject({ draft: false })
    expect(post.attempts['latest.yml']).toBe(2)
    expect(run.out.lines.join('\n')).toContain('latest.yml: attempt 1 did not land, retrying')
    expect(gh.snapshots).toHaveLength(1)
  })

  it('also replaces a release that was already PUBLISHED for this tag', async () => {
    const gh = fakeGitHub()
    await (ship(gh)).promise
    const old = gh.releases[0].id
    await (ship(gh)).promise
    expect(gh.releases).toHaveLength(1)
    expect(gh.releases[0].id).not.toBe(old)
    expect(gh.public()).toHaveLength(1)
  })
})

describe('uploadAsset on its own', () => {
  it('gives up after the attempts it is allowed, naming the file', async () => {
    const gh = fakeGitHub()
    gh.releases.push({ id: 1, tag_name: TAG, draft: true })
    gh.assets.set(1, [])
    const post = fakeUpload(gh, { [EXE]: ['fail', 'fail'] })
    await expect(
      uploadAsset({
        api: githubApi({ token: 't', fetchImpl: gh.fetchImpl }),
        repoPath: REPO,
        releaseId: 1,
        asset: ASSETS[0],
        postAsset: post,
        log: () => {},
        tries: 2,
      }),
    ).rejects.toThrow(`${EXE} did not upload after 2 attempts`)
  })
})

describe('githubApi', () => {
  it('sends the token and the API version, and reads JSON back', async () => {
    let seen
    const api = githubApi({
      token: 'secret',
      fetchImpl: async (url, opts) => {
        seen = { url, headers: opts.headers }
        return { ok: true, status: 200, text: async () => '{"a":1}' }
      },
    })
    await expect(api('/repos/x/y')).resolves.toEqual({ a: 1 })
    expect(seen.url).toBe('https://api.github.com/repos/x/y')
    expect(seen.headers.Authorization).toBe('token secret')
    expect(seen.headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('turns a refusal into one line with the status, the path and the reason', async () => {
    const api = githubApi({
      token: 't',
      fetchImpl: async () => ({ ok: false, status: 422, text: async () => '{"message":"already_exists"}' }),
    })
    await expect(api('/repos/x/y/releases')).rejects.toThrow('GitHub 422 /repos/x/y/releases: already_exists')
  })

  it('keeps the words of an error page that is not JSON', async () => {
    const api = githubApi({
      token: 't',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' }),
    })
    await expect(api('/x')).rejects.toThrow('GitHub 502 /x: <html>Bad gateway</html>')
  })
})
