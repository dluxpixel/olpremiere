// The main process's diary, logs/main.log. See ./mainLog.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatEntry, mainLog, mainLogger, setMainLogFile } from './mainLog'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'olp-mainlog-'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  setMainLogFile(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('mainLog', () => {
  it('keeps what used to go only to a console nobody can read', () => {
    const file = path.join(dir, 'logs', 'main.log')
    setMainLogFile(file)
    mainLog('warn', 'OL Premiere: preview copy failed, preview will use the original', new Error('boom'))
    const kept = readFileSync(file, 'utf8')
    expect(kept).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z warn OL Premiere: preview copy failed/)
    expect(kept).toContain('Error: boom')
    expect(console.warn).toHaveBeenCalled()
  })

  it('writes nothing until main says where', () => {
    mainLog('info', 'early')
    expect(existsSync(path.join(dir, 'logs'))).toBe(false)
    expect(console.log).toHaveBeenCalledWith('early')
  })

  it('never throws, even with nowhere to write', () => {
    setMainLogFile(path.join(dir, 'a-file'))
    mainLog('info', 'x')
    setMainLogFile(path.join(dir, 'a-file', 'under-a-file.log'))
    expect(() => mainLog('error', 'y')).not.toThrow()
  })

  it('is what the updater writes its own account through', () => {
    const file = path.join(dir, 'main.log')
    setMainLogFile(file)
    mainLogger.info('Checking for update')
    mainLogger.error(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const kept = readFileSync(file, 'utf8')
    expect(kept).toContain('info Checking for update')
    expect(kept).toContain('error Error: net::ERR_INTERNET_DISCONNECTED')
  })
})

describe('formatEntry', () => {
  const at = new Date('2026-10-06T12:00:00.000Z')

  it('keeps a stack readable and every entry bounded', () => {
    const entry = formatEntry(at, 'error', [new Error('boom')])
    expect(entry.startsWith('2026-10-06T12:00:00.000Z error Error: boom\n    ')).toBe(true)
    expect(formatEntry(at, 'info', ['x'.repeat(50_000)]).length).toBeLessThan(4100)
  })

  it('reads odd values without throwing', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(formatEntry(at, 'info', [{ a: 1 }, loop, undefined])).toContain('{"a":1}')
  })
})

// The wiring, at the source level like src/updateErrorWiring.test.ts: what breaks here
// breaks only in a packaged build, where nobody can see the console it fell back to.
describe('the main process writes to it', () => {
  const here = new URL('./', import.meta.url)
  const read = (name: string): string => readFileSync(new URL(name, here), 'utf8')
  /** Code only, so a comment that names console to explain why is not read as a call. */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('main points it at logs/main.log and hands it to the updater', () => {
    const main = read('main.ts')
    expect(main).toContain("setMainLogFile(path.join(app.getPath('logs'), MAIN_LOG_NAME))")
    expect(main).toMatch(/startUpdateFlow\(\{[^}]*logger: mainLogger,/)
  })

  it('no main process line goes only to the console', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'mainLog.ts')
    expect(files).toContain('main.ts')
    for (const f of files) expect(code(read(f)), f).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/)
  })
})
