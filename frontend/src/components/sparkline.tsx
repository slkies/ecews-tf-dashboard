/**
 * A tile's trend at a glance, drawn from the quarterly cascade.
 *
 * The last point is dashed and hollow by default. The latest enrolment quarter
 * has not finished happening - episodes in it are still moving through EAC -
 * so its rate is provisional, and a solid line ending on it would read as a
 * collapse that is only arithmetic.
 */
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
  const pts = values
    .map((v, i) => [i, v] as const)
    .filter((p): p is readonly [number, number] => p[1] != null && !Number.isNaN(p[1]))
  if (pts.length < 2) return null

  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  if (hi === lo) { hi += 1; lo -= 1 }

  const pad = 3.5
  const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad)
  const sy = (y: number) => pad + (1 - (y - lo) / (hi - lo)) * (height - 2 * pad)
  const coords = pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
  const solid = provisionalLast ? coords.slice(0, -1) : coords
  const last = pts[pts.length - 1]!

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         role="img" aria-label={label} className="shrink-0 overflow-visible">
      {solid.length > 1 && (
        <polyline points={solid.join(' ')} fill="none" stroke="var(--primary)"
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {provisionalLast && (
        <polyline points={coords.slice(-2).join(' ')} fill="none"
                  stroke="var(--muted-foreground)" strokeWidth={2}
                  strokeDasharray="3 3" strokeLinecap="round" />
      )}
      <circle cx={sx(last[0])} cy={sy(last[1])} r={2.75} fill="var(--card)"
              stroke={provisionalLast ? 'var(--muted-foreground)' : 'var(--primary)'}
              strokeWidth={2} />
    </svg>
  )
}
