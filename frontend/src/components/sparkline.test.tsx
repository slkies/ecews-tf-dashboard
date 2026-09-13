import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './sparkline'

describe('Sparkline', () => {
  it('draws nothing from fewer than two points', () => {
    const { container } = render(<Sparkline values={[80, null]} label="x" />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('dashes the last segment, because the latest quarter is still maturing', () => {
    const { container } = render(<Sparkline values={[90, 88, 86, 76]} label="Commenced EAC" />)
    const lines = container.querySelectorAll('polyline')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.getAttribute('stroke-dasharray')).toBe('3 3')
  })

  it('draws a solid line throughout when the last point is final', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} label="x" provisionalLast={false} />)
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
  })

  it('names what it shows for assistive technology', () => {
    const { getByRole } = render(<Sparkline values={[1, 2]} label="Re-suppressed by quarter" />)
    expect(getByRole('img', { name: 'Re-suppressed by quarter' })).toBeInTheDocument()
  })
})
