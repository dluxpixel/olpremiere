// A second copy of the app on the SAME profile must hand over and end at once, before
// its startup runs: that startup sweeps temp files it believes nobody is using, and on
// one profile they are the first copy's live files (electron/main.ts, the single
// instance lock). Plants a conversion temp, starts copy two, and checks it is gone
// within five seconds, loaded no page, and left the temp alone.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const { app } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ root, log, repo }) => {
  const userData = app.getPath('userData')
  const planted = path.join(userData, 'remux', `in-${randomUUID()}`)
  fs.mkdirSync(path.dirname(planted), { recursive: true })
  fs.writeFileSync(planted, 'the first copy is still converting this')
  const logFile = path.join(root, 'log.txt')
  const loadedBefore = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('loaded ')).length

  let handedOver = false
  app.once('second-instance', () => {
    handedOver = true
  })
  const t0 = Date.now()
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'hidden-app', 'app'), `--user-data-dir=${userData}`], {
    // No check of its own, and a short fuse in case it does start up.
    env: { ...process.env, OLP_HIDDEN_DIR: root, OLP_HIDDEN_CHECK: '', OLP_HIDDEN_TIMEOUT_MS: '20000' },
    stdio: 'ignore',
    windowsHide: true,
  })
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve('killed')
    }, 25000)
  })
  const ms = Date.now() - t0
  await sleep(500)
  const loadedAfter = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('loaded ')).length
  const kept = fs.existsSync(planted)
  log('second copy exit:', code, 'after', ms, 'ms; pages it loaded:', loadedAfter - loadedBefore, '; temp kept:', kept, '; handed over:', handedOver)
  fs.rmSync(planted, { force: true })
  if (ms > 5000) throw new Error(`the second copy took ${ms} ms to end`)
  if (loadedAfter !== loadedBefore) throw new Error('the second copy loaded pages: it ran the startup')
  if (!kept) throw new Error("the second copy swept the first copy's live conversion temp")
  if (!handedOver) throw new Error('the click was not handed to the first copy')
  return { code, ms, kept, handedOver }
}
