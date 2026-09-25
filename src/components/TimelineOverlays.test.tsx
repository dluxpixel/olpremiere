/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RULER_H } from './timelineGeometry'
import { EmptyTimelineHint, MarqueeBox, RazorLine, SnapLine, TrimTip } from './TimelineOverlays'

afterEach(cleanup)

describe('timeline overlays', () => {
  it('draws the snap line at its time, under the ruler', () => {
    render(<SnapLine t={2} pxPerS={50} />)
    const line = screen.getByTestId('snap-line')
    expect(line.style.left).toBe('100px')
    expect(line.style.top).toBe(`${RULER_H}px`)
  })

  it('remounts the snap line when keyed on a new time, so the pulse fires again', () => {
    const { rerender } = render(<SnapLine key={1} t={1} pxPerS={50} />)
    const first = screen.getByTestId('snap-line')
    rerender(<SnapLine key={1} t={1} pxPerS={50} />)
    expect(screen.getByTestId('snap-line')).toBe(first)
    rerender(<SnapLine key={2} t={2} pxPerS={50} />)
    expect(screen.getByTestId('snap-line')).not.toBe(first)
  })

  it('draws the razor line at its time', () => {
    render(<RazorLine t={3} pxPerS={10} />)
    expect(screen.getByTestId('razor-line').style.left).toBe('30px')
  })

  it('draws the marquee from any corner', () => {
    const { container } = render(<MarqueeBox box={{ x0: 80, y0: 60, x1: 20, y1: 100 }} />)
    const box = container.firstElementChild as HTMLElement
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['20px', '60px', '60px', '40px'])
  })

  it('says how to start on an empty timeline', () => {
    render(<EmptyTimelineHint />)
    expect(screen.getByText('Drag a clip here to start')).toBeTruthy()
  })

  it('floats the readout where it is told', () => {
    render(<TrimTip tip={{ x: 12, y: 34, text: 'Trim +1f' }} />)
    const tip = screen.getByText('Trim +1f')
    expect(tip.style.left).toBe('12px')
    expect(tip.style.top).toBe('34px')
    expect(tip.className).toContain('fixed')
  })
})
