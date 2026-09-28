import { beforeEach, describe, expect, it } from 'vitest'
import { answerNamePrompt, askForName, useNamePrompt } from './namePrompt'

beforeEach(() => {
  useNamePrompt.setState({ request: null, resolve: null })
})

describe('askForName', () => {
  it('opens one question and resolves with the trimmed answer', async () => {
    const asked = askForName({ title: 'New category', confirmLabel: 'Make it' })
    expect(useNamePrompt.getState().request?.title).toBe('New category')
    answerNamePrompt('  Battle Cats  ')
    expect(await asked).toBe('Battle Cats')
    expect(useNamePrompt.getState().request).toBeNull()
  })

  it('resolves null when he backs out', async () => {
    const asked = askForName({ title: 'New category', confirmLabel: 'Make it' })
    answerNamePrompt(null)
    expect(await asked).toBeNull()
  })

  it('a second question answers the first with null, so nothing waits forever', async () => {
    const first = askForName({ title: 'First', confirmLabel: 'OK' })
    const second = askForName({ title: 'Second', confirmLabel: 'OK' })
    expect(await first).toBeNull()
    expect(useNamePrompt.getState().request?.title).toBe('Second')
    answerNamePrompt('Minecraft')
    expect(await second).toBe('Minecraft')
  })
})
