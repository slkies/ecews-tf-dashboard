/**
 * A tile's trend at a glance, drawn from the quarterly cascade.
 *
 * The line is a monotone cubic curve rather than straight segments: it reads
 * as a trend instead of a row of sharp corners, and - unlike an ordinary
 * smoothing spline - it never overshoots between points, so a rate that
 * peaks at 90% is never drawn briefly above it.
 *
 * The last segment is dashed and its end point hollow by default. The latest
 * enrolment quarter has not finished happening, so its rate is provisional,
 * and a solid line ending on it would read as a collapse that is only
 * arithmetic.
 */

type Pt = readonly [number, number]

/**
 * Fritsch-Carlson monotone cubic interpolation, one Bezier per interval.
 * Returns the control points of each segment so the caller can style the
 * last one differently.
 */
export function monotoneSegments(pts: Pt[]): [Pt, Pt, Pt, Pt][] {
  const n = pts.length
  if (n < 2) return []
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0])
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1))
  }
  const t: number[] = new Array(n)
  t[0] = m[0]!
  t[n - 1] = m[n - 2]!
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i]! / m[i]!
    const b = t[i + 1]! / m[i]!
    const h = a * a + b * b
    if (h > 9) {
      const tau = 3 / Math.sqrt(h)
      t[i] = tau * a * m[i]!
      t[i + 1] = tau * b * m[i]!
    }
  }
  return pts.slice(0, -1).map((p, i) => {
    const q = pts[i + 1]!
    const third = dx[i]! / 3
    return [p, [p[0] + third, p[1] + t[i]! * third], [q[0] - third, q[1] - t[i + 1]! * third], q]
  })
}

const f = (v: number) => v.toFixed(1)
const toPath = (segs: [Pt, Pt, Pt, Pt][]) =>
  segs.length
    ? `M${f(segs[0]![0][0])},${f(segs[0]![0][1])}` +
      segs.map(([, c1, c2, e]) => ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(e[0])},${f(e[1])}`).join('')
    : ''

export function Sparkline({
  values,
  label,
  provisionalLast = true,
  width = 96,
  height = 32,
}: {
  values: (number | null | undefined)[]
  /** What the line shows, for assistive technology. */
  label: string
  provisionalLast?: boolean
  width?: number
  height?: number
}) {
  const raw = values
    .map((v, i) => [i, v] as const)
    .filter((p): p is readonly [number, number] => p[1] != null && !Number.isNaN(p[1]))
  if (raw.length < 2) return null

  const xs = raw.map((p) => p[0])
  const ys = raw.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  if (hi === lo) { hi += 1; lo -= 1 }

  const pad = 3.5
  const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad)
  const sy = (y: number) => pad + (1 - (y - lo) / (hi - lo)) * (height - 2 * pad)
  const pts: Pt[] = raw.map(([x, y]) => [sx(x), sy(y)])
  const segs = monotoneSegments(pts)
  const solid = provisionalLast ? segs.slice(0, -1) : segs
  const last = pts[pts.length - 1]!

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         role="img" aria-label={label} className="shrink-0 overflow-visible">
      {solid.length > 0 && (
        <path d={toPath(solid)} fill="none" stroke="var(--primary)"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {provisionalLast && (
        <path d={toPath(segs.slice(-1))} fill="none" stroke="var(--muted-foreground)"
              strokeWidth={2} strokeDasharray="3 3" strokeLinecap="round" />
      )}
      <circle cx={last[0]} cy={last[1]} r={2.75} fill="var(--card)"
              stroke={provisionalLast ? 'var(--muted-foreground)' : 'var(--primary)'}
              strokeWidth={2} />
    </svg>
  )
}
