import { useEffect, useMemo, useState } from 'react'
import { fmt } from '@/core/format'

/**
 * Where unsuppressed clients LIVE, by LGA.
 *
 * Plain SVG over the bundled geoBoundaries polygons - no mapping library. The
 * three programme states cover a small enough area that an equirectangular
 * projection (longitude/latitude straight onto x/y) is visually exact, and
 * framing on them keeps their LGAs large; neighbouring states are drawn behind
 * for context and crop at the edge.
 *
 * Shade is one hue, light to dark, on sqrt(n/max) so a single large LGA does
 * not flatten the rest. LGAs with no matched residents keep the empty tone -
 * that is a data gap, not a zero.
 */
export interface LgaCounts {
  counts: Record<string, { n: number; f: number; m: number; peds: number; adol: number }>
  total: number
}

interface Feature {
  properties: { key?: string; lga?: string; state?: string; focus?: boolean; c?: [number, number] }
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
}

type Pt = [number, number]          // longitude, latitude
const rings = (g: Feature['geometry']): Pt[][] =>
  (g.type === 'MultiPolygon' ? (g.coordinates as unknown as Pt[][][]) : [g.coordinates as unknown as Pt[][]]).flat()

export default function LgaMap({ res }: { res: LgaCounts | null | undefined }) {
  const [geo, setGeo] = useState<{ features: Feature[] } | null>(null)
  const [ctx, setCtx] = useState<{ features: Feature[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    fetch('/nga_lga_3states.geojson')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('boundary file not found'))))
      .then((j: { features?: Feature[] }) => {
        if (off) return
        if (Array.isArray(j?.features)) setGeo({ features: j.features })
        else setErr('boundary file unreadable')
      })
      .catch((e: unknown) => { if (!off) setErr(e instanceof Error ? e.message : 'map unavailable') })
    fetch('/nga_context_states.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { features: Feature[] } | null) => { if (!off && j) setCtx(j) })
      .catch(() => { /* context is optional */ })
    return () => { off = true }
  }, [])

  const drawn = useMemo(() => {
    if (!geo) return null
    const ctxFeats = ctx?.features ?? []
    const focus = ctxFeats.filter((f) => f.properties.focus)
    const background = ctxFeats.filter((f) => !f.properties.focus)

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
    const grow = (f: Feature) => rings(f.geometry).forEach((ring) => ring.forEach(([x, y]) => {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }))
    ;(focus.length ? focus : (ctxFeats.length ? ctxFeats : geo.features)).forEach(grow)
    const padX = (maxX - minX) * 0.1, padY = (maxY - minY) * 0.1
    minX -= padX; maxX += padX; minY -= padY; maxY += padY
    const W = 1000, H = Math.round(W * (maxY - minY) / (maxX - minX))
    const sx = (x: number) => ((x - minX) / (maxX - minX) * W).toFixed(1)
    const sy = (y: number) => ((maxY - y) / (maxY - minY) * H).toFixed(1)
    const d = (f: Feature) => rings(f.geometry)
      .map((ring) => `M${ring.map(([x, y]) => `${sx(x)},${sy(y)}`).join('L')}Z`).join('')

    const counts = res?.counts ?? {}
    let max = 0, matched = 0
    geo.features.forEach((f) => {
      const n = counts[f.properties.key ?? '']?.n ?? 0
      if (n > max) max = n
      matched += n
    })
    return { W, H, sx, sy, d, focus, background, counts, max, matched }
  }, [geo, ctx, res])

  if (err) return <p className="py-10 text-center text-sm text-muted-foreground">Map unavailable: {err}</p>
  if (!drawn) return <div className="h-72 w-full animate-pulse rounded-lg bg-muted" aria-label="Loading the map" />

  const { W, H, sx, sy, d, focus, background, counts, max, matched } = drawn
  const total = res?.total ?? 0
  // One hue: the brand green mixed into the empty tone. Depth is sqrt-scaled.
  const shade = (n: number) => n
    ? `color-mix(in oklch, var(--primary) ${Math.round(Math.sqrt(n / max) * 88 + 12)}%, var(--muted))`
    : 'var(--muted)'

  return (
    <div className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
           aria-label="Map of unsuppressed clients by LGA of residence across Delta, Osun and Ekiti, with neighbouring states in grey for context">
        {background.map((f, i) => (
          <path key={`b${i}`} d={d(f)} fill="var(--muted)" opacity={0.45}
                stroke="var(--border)" strokeWidth={0.6}>
            <title>{f.properties.state} State</title>
          </path>
        ))}
        {geo!.features.map((f, i) => {
          const b = counts[f.properties.key ?? '']
          const n = b?.n ?? 0
          const detail = n
            ? `${fmt(n)} residing (${fmt(b!.f)}F / ${fmt(b!.m)}M · under 20: ${fmt((b!.peds ?? 0) + (b!.adol ?? 0))}, of which ${fmt(b!.peds)} under 10)`
            : 'no matched entries'
          return (
            <path key={`l${i}`} d={d(f)} fillRule="evenodd" fill={shade(n)}
                  stroke="var(--background)" strokeWidth={0.8}>
              <title>{`${f.properties.lga} (${f.properties.state}) — ${detail}`}</title>
            </path>
          )
        })}
        {focus.map((f, i) => (
          <path key={`f${i}`} d={d(f)} fill="none" stroke="var(--foreground)" strokeWidth={1.4} opacity={0.65} />
        ))}
        {background.map((f, i) => f.properties.c ? (
          <text key={`bl${i}`} x={sx(f.properties.c[0])} y={sy(f.properties.c[1])}
                textAnchor="middle" className="fill-muted-foreground text-[11px]">
            {f.properties.state}
          </text>
        ) : null)}
        {focus.map((f, i) => f.properties.c ? (
          <text key={`fl${i}`} x={sx(f.properties.c[0])} y={sy(f.properties.c[1])}
                textAnchor="middle" className="fill-foreground text-[13px] font-medium">
            {f.properties.state}
          </text>
        ) : null)}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          0
          <span className="h-2.5 w-24 rounded-[3px]"
                style={{ background: 'linear-gradient(to right, color-mix(in oklch, var(--primary) 12%, var(--muted)), var(--primary))' }} />
          {fmt(max)} residing
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-muted" />No matched entries
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-muted opacity-45" />Neighbouring state
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {fmt(matched)} of {fmt(total)} residence entries
        {total ? ` (${Math.round(matched / total * 100)}%)` : ''} matched one of the 71 LGAs in
        Delta, Osun and Ekiti. The EMR field is free text, so unmatched entries are towns,
        misspellings, or residences outside the three states. They are counted here rather than
        forced onto the map.
      </p>
    </div>
  )
}
