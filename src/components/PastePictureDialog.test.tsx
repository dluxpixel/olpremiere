/**
 * @vitest-environment jsdom
 *
 * The question every pasted picture asks. His words, 2026-09-28: *"When I paste
 * something, I can select, when pasting it, to remove the background
 * automatically."* His pick: ask on every paste.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CutoutResult } from '../../electron/ipc-types'

const hoisted = vi.hoisted(() => ({ imported: [] as File[] }))

vi.mock('../state/mediaActions', () => ({
  importFiles: (files: File[]) => {
    hoisted.imported.push(...files)
    return Promise.resolve([])
  },
}))
vi.mock('../state/toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

import { cancelPicturePaste, offerPicture } from '../state/picturePaste'
import { PastePictureDialog } from './PastePictureDialog'

const picture = (): File => new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })

/** A desktop shell whose CutStudio answers when the test says so. */
function desktop(): { answer: (r: CutoutResult) => void; calls: { bytes: number; mime: string }[] } {
  let answer: (r: CutoutResult) => void = () => {}
  const calls: { bytes: number; mime: string }[] = []
  ;(window as { api?: unknown }).api = {
    isElectron: true,
    removeBackground: (bytes: ArrayBuffer, mime: string) => {
      calls.push({ bytes: bytes.byteLength, mime })
      return new Promise<CutoutResult>((resolve) => {
        answer = resolve
      })
    },
  }
  return { answer: (r) => answer(r), calls }
}

beforeEach(() => {
  hoisted.imported.length = 0
  URL.createObjectURL = vi.fn(() => 'blob:pasted')
  URL.revokeObjectURL = vi.fn()
  // jsdom's Blob has no arrayBuffer(); the browser's does.
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.readAsArrayBuffer(this)
      })
    }
  }
})

afterEach(() => {
  act(() => cancelPicturePaste())
  cleanup()
  delete (window as { api?: unknown }).api
})

const open = (): void => {
  act(() => offerPicture(picture()))
  render(<PastePictureDialog />)
}

describe('PastePictureDialog', () => {
  it('shows nothing until a picture is pasted', () => {
    render(<PastePictureDialog />)
    expect(screen.queryByTestId('paste-picture-dialog')).toBeNull()
  })

  it('asks with the picture and two plain choices', () => {
    desktop()
    open()
    expect(screen.getByTestId('paste-picture-thumb').getAttribute('src')).toBe('blob:pasted')
    expect(screen.getByRole('button', { name: 'Keep background' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('on the web, Remove background is off and says why', () => {
    open()
    expect((screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('paste-picture-web').textContent).toBe('Removing the background needs the desktop app.')
  })

  it('Escape pastes nothing', async () => {
    open()
    await userEvent.setup().keyboard('{Escape}')
    expect(screen.queryByTestId('paste-picture-dialog')).toBeNull()
    expect(hoisted.imported).toEqual([])
  })

  it('Keep background pastes the picture as it is', async () => {
    open()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keep background' }))
    expect(screen.queryByTestId('paste-picture-dialog')).toBeNull()
    expect(hoisted.imported).toHaveLength(1)
    expect(hoisted.imported[0]!.name).toMatch(/^Pasted picture \d\d-\d\d-\d\d\.png$/)
  })

  it('Remove background shows it working, then pastes the cut out PNG', async () => {
    const shell = desktop()
    open()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove background' }))
    expect(screen.getByTestId('paste-picture-working').textContent).toContain('Removing the background')
    await vi.waitFor(() => expect(shell.calls).toEqual([{ bytes: 3, mime: 'image/png' }]))
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
    await act(async () => shell.answer({ ok: true, png }))
    expect(screen.queryByTestId('paste-picture-dialog')).toBeNull()
    expect(hoisted.imported).toHaveLength(1)
    expect(hoisted.imported[0]!.type).toBe('image/png')
    expect(hoisted.imported[0]!.name).toMatch(/ no background\.png$/)
  })

  it('says plainly when CutStudio is missing, and still offers the picture as it is', async () => {
    const shell = desktop()
    open()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove background' }))
    await vi.waitFor(() => expect(shell.calls).toHaveLength(1))
    await act(async () => shell.answer({ ok: false, reason: 'not-found', detail: 'no cutstudio.exe' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'Can’t find CutStudio on this computer. You can still paste it with its background.',
    )
    expect(hoisted.imported).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Keep background' }))
    expect(hoisted.imported).toHaveLength(1)
    expect(hoisted.imported[0]!.name).not.toMatch(/no background/)
  })

  it('a cutout that finishes after he cancelled is dropped', async () => {
    const shell = desktop()
    open()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove background' }))
    await vi.waitFor(() => expect(shell.calls).toHaveLength(1))
    act(() => cancelPicturePaste())
    await act(async () => shell.answer({ ok: true, png: new ArrayBuffer(8) }))
    expect(hoisted.imported).toEqual([])
  })
})
