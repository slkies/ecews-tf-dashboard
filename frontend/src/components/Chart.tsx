import {
  Chart as ChartJS, type ChartConfiguration, registerables,
} from 'chart.js'
import { useEffect, useRef } from 'react'
import { useTheme } from '../core/theme'

ChartJS.register(...registerables)

/**
 * A Chart.js canvas that behaves in React.
 *
 * Two things this has to get right, both of which are leaks rather than
 * visible bugs until the page has been open a while:
 *
 *  - one instance per canvas. Chart.js keeps a registry keyed on the element,
 *    and rendering over a live chart throws "Canvas is already in use". The
 *    instance is destroyed on unmount and before every re-create.
 *  - the axis and grid colours are read from the CSS custom properties at
 *    draw time, so a theme switch repaints the chart instead of leaving dark
 *    grid lines on a white card.
 */
export default function Chart({ config, height = 290, ariaLabel }: {
  config: ChartConfiguration
  height?: number
  ariaLabel?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const chart = useRef<ChartJS | null>(null)
  const { theme } = useTheme()

  useEffect(() => {
    const el = canvas.current
    if (!el) return

    // Axis text and gridlines follow the shadcn tokens, so a chart reads as
    // part of the card it sits in, in either theme.
    const css = getComputedStyle(document.documentElement)
    const tick = css.getPropertyValue('--muted-foreground').trim() || '#7a796c'
    const grid = css.getPropertyValue('--border').trim() || '#e6e5dd'

    ChartJS.defaults.color = tick
    ChartJS.defaults.borderColor = grid
    ChartJS.defaults.font.family =
      "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    ChartJS.defaults.font.size = 11
    // Every line in the app is a smooth monotone curve. Monotone rather than a
    // tension spline because it never overshoots between points: a rate that
    // peaks at 100% is never drawn above it, and a zero never dips below.
    ChartJS.defaults.elements.line.cubicInterpolationMode = 'monotone'
    ChartJS.defaults.elements.point.radius = 0
    ChartJS.defaults.elements.point.hoverRadius = 4

    chart.current?.destroy()
    chart.current = new ChartJS(el, config)

    return () => { chart.current?.destroy(); chart.current = null }
    // `theme` is a dependency because the palette above is read at create time.
  }, [config, theme])

  return (
    <div style={{ position: 'relative', height }}>
      <canvas ref={canvas} role="img" aria-label={ariaLabel} />
    </div>
  )
}
