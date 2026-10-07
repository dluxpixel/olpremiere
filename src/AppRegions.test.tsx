// @vitest-environment jsdom
//
// A splitter drag moves one edge, so it should render the panel whose size changed and nothing
// else. The sizes are App's state, and none of the big regions was memo, so every pointer move of
// a drag rendered the top bar, the tabs, all three columns and the timeline again, and wrote the
// layout to storage on every move. The regions are stand ins here that count their renders.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { renders, counted } = vi.hoisted(() => {
  const renders: Record<string, number> = {}
  const counted = (name: string, testId?: string) => (props: { width?: number; height?: number }) => {
    renders[name] = (renders[name] ?? 0) + 1
    return <div data-testid={testId} style={{ width: props.width, height: props.height }} />
  }
  return { renders, counted }
})
vi.mock('./components/TopBar', () => ({ TopBar: counted('TopBar') }))
vi.mock('./components/EditTabs', () => ({ EditTabs: counted('EditTabs') }))
vi.mock('./components/LeftPanel', () => ({ LeftPanel: counted('LeftPanel', 'panel-left') }))
vi.mock('./components/Monitor', () => ({ Monitor: counted('Monitor') }))
vi.mock('./components/Inspector', () => ({ Inspector: counted('Inspector', 'panel-right') }))
vi.mock('./components/Timeline', () => ({ Timeline: counted('Timeline') }))

import App from './App'

const LAYOUT_KEY = 'olpremiere.layout.v2'

beforeEach(() => {
  for (const k of Object.keys(renders)) delete renders[k]
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true })
  localStorage.clear()
  let held = false
  HTMLElement.prototype.setPointerCapture = () => {
    held = true
  }
  HTMLElement.prototype.hasPointerCapture = () => held
  HTMLElement.prototype.releasePointerCapture = () => {
    held = false
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a splitter drag', () => {
  it('renders only the panel it resizes, and writes the layout once, when he lets go', () => {
    render(<App />)
    const before = { ...renders }
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const handle = screen.getByTestId('splitter-left')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1 })
    for (let x = 281; x <= 330; x++) fireEvent.pointerMove(handle, { clientX: x, pointerId: 1 })

    expect(screen.getByTestId('panel-left').style.width).toBe('330px')
    expect(renders.LeftPanel - before.LeftPanel).toBe(50)
    for (const still of ['TopBar', 'EditTabs', 'Monitor', 'Inspector', 'Timeline']) {
      expect(renders[still], `${still} rendered during the drag`).toBe(before[still])
    }
    expect(writes.mock.calls.filter(([k]) => k === LAYOUT_KEY)).toEqual([])

    fireEvent.pointerUp(handle, { clientX: 330, pointerId: 1 })
    const layoutWrites = writes.mock.calls.filter(([k]) => k === LAYOUT_KEY)
    expect(layoutWrites).toHaveLength(1)
    expect(JSON.parse(layoutWrites[0][1] as string).left).toBe(330)
  })
})
