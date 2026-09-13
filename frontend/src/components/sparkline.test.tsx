import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { monotoneSegments, Sparkline } from './sparkline'

describe('Sparkline', () => {
  it('draws nothing from fewer than two points', () => {
    const { container } = render(<Sparkline values={[80, null]} label="x" />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('draws a smooth curve, not straight segments', () => {
    const { container } = render(<Sparkline values={[90, 88, 86, 76]} label="Commenced EAC" />)
    const d = container.querySelector('path')!.getAttribute('d')!
    expect(d.startsWith('M')).toBe(true)
    expect(d).toContain(' C')                       // cubic Bezier segments
    expect(container.querySelector('polyline')).toBeNull()
  })

  it('dashes the last segment, because the latest quarter is still maturing', () => {
    const { container } = render(<Sparkline values={[90, 88, 86, 76]} label="Commenced EAC" />)
    const paths = container.querySelectorAll('path')
    expect(paths).toHaveLength(2)
    expect(paths[1]!.getAttribute('stroke-dasharray')).toBe('3 3')
  })

  it('draws a solid line throughout when the last point is final', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} label="x" provisionalLast={false} />)
    expect(container.querySelectorAll('path')).toHaveLength(1)
  })

  it('names what it shows for assistive technology', () => {
    const { getByRole } = render(<Sparkline values={[1, 2]} label="Re-suppressed by quarter" />)
    expect(getByRole('img', { name: 'Re-suppressed by quarter' })).toBeInTheDocument()
  })
})

describe('monotoneSegments', () => {
  it('never overshoots: control points stay within the neighbouring values', () => {
    // A peak then a plateau - an ordinary spline would bulge past 90.
    const pts: [number, number][] = [[0, 50], [10, 90], [20, 90], [30, 60]]
    for (const [p, c1, c2, q] of monotoneSegments(pts)) {
      const lo = Math.min(p[1], q[1])
      const hi = Math.max(p[1], q[1])
      for (const c of [c1, c2]) {
        expect(c[1]).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(c[1]).toBeLessThanOrEqual(hi + 1e-9)
      }
    }
  })

  it('passes exactly through every data point', () => {
    const pts: [number, number][] = [[0, 1], [5, 4], [9, 2]]
    const segs = monotoneSegments(pts)
    expect(segs.map((s) => s[0])).toEqual(pts.slice(0, -1))
    expect(segs[segs.length - 1]![3]).toEqual(pts[pts.length - 1])
  })
})
