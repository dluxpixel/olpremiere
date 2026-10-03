/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useRecorder } from '../state/voiceRecorder'
import { RecordingStudio } from './RecordingStudio'

// ⛔ MIC-3, 2026-09-30. The studio's meter was full at -2.4 dBFS and always
// green, with no clip light, and 5 of his 65 takes touched full scale. It reads
// in dBFS now, in the same place, with the app's own colours.

afterEach(() => {
  cleanup()
  useRecorder.setState({ level: 0, clipped: false, inputLabel: '', inputMissing: false, selectedInputId: null, selectedInputLabel: null })
})

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

describe('the recording meter', () => {
  it('shows its scale: -18, -12, -6 and 0 dBFS', () => {
    render(<RecordingStudio />)
    const meter = screen.getByTestId('studio-level').parentElement!
    expect(meter.textContent).toBe('-18-12-60')
  })

  it('is NOT full at -2.4 dBFS, where the old bar ran out', async () => {
    render(<RecordingStudio />)
    useRecorder.setState({ level: 10 ** (-2.4 / 20) })
    await frame()
    await frame()
    // 96% lit, so 4% still covered.
    expect(parseFloat(screen.getByTestId('studio-level-unlit').style.width)).toBeCloseTo(4, 1)
  })

  it('the clip light is lit while the take is clipped, and his click puts it out', () => {
    render(<RecordingStudio />)
    const light = screen.getByTestId('studio-clip')
    expect(light.getAttribute('aria-pressed')).toBe('false')
    act(() => useRecorder.setState({ clipped: true }))
    expect(screen.getByTestId('studio-clip').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('studio-clip').className).toContain('bg-danger')
    fireEvent.click(screen.getByTestId('studio-clip'))
    expect(useRecorder.getState().clipped).toBe(false)
  })
})

// ⛔ MIC-8. The studio showed the mic he picked, not the one recording.
describe('the input he is really recording from', () => {
  it('is named under the picker', () => {
    useRecorder.setState({ inputLabel: 'USB Microphone' })
    render(<RecordingStudio />)
    expect(screen.getByTestId('studio-input-live').textContent).toBe('Recording from USB Microphone')
  })

  it('says so when his mic is not connected and another is recording', () => {
    useRecorder.setState({ inputLabel: 'Microphone (Realtek Audio)', inputMissing: true })
    render(<RecordingStudio />)
    const line = screen.getByTestId('studio-input-live')
    expect(line.textContent).toBe('Not connected. Recording from Microphone (Realtek Audio)')
    expect(line.className).toContain('text-warning')
  })
})

// ⛔ Keep claims the take at once now (review, 2026-10-01), and the read and the
// import can take seconds on a long take: the panel stays and says so.
describe('keeping a take', () => {
  it('the button says it is adding, and neither button can be pressed meanwhile', () => {
    act(() => useRecorder.setState({ keeping: true, pendingTake: null }))
    render(<RecordingStudio />)
    const keep = screen.getByTestId('studio-keep')
    expect(keep.textContent).toBe('Adding...')
    expect((keep as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('studio-discard') as HTMLButtonElement).disabled).toBe(true)
    act(() => useRecorder.setState({ keeping: false }))
  })

  it('the take under review is added to the timeline, which is what Keep does now', () => {
    const take = { url: 'blob:x', blob: new Blob(['x']), mime: 'audio/wav', name: 'Voice recording 1.wav', durationS: 1 }
    act(() => useRecorder.setState({ pendingTake: take as never }))
    render(<RecordingStudio />)
    expect(screen.getByTestId('studio-keep').textContent).toBe('Add to timeline')
    act(() => useRecorder.setState({ pendingTake: null }))
  })
})
