import type { ChartConfiguration } from 'chart.js'
import { useMemo } from 'react'
import Chart from './Chart'

export interface Slice { label: string; value: number; color: string }

/**
 * A doughnut with a figure in the hole and a legend beneath.
 *
 * The figure in the centre is HTML, not drawn on the canvas, so it stays
 * crisp, selectable, and readable by assistive technology - the chart is
 * decoration around a number, not the other way round.
 */
export default function DonutCard({ title, big, sub, slices, tooltip, legend }: {
  title: string
  big: string
  sub: string
  slices: Slice[]
  /** Text for a slice's tooltip line. */
  tooltip: (s: Slice) => string
  /** Text for a slice's legend entry, shown in bold after the label. */
  legend: (s: Slice) => string
}) {
  const config = useMemo<ChartConfiguration>(() => ({
    type: 'doughnut',
    data: {
      labels: slices.map((s) => s.label),
      datasets: [{ data: slices.map((s) => s.value),
                   backgroundColor: slices.map((s) => s.color), borderWidth: 0 }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (i) => tooltip(slices[i.dataIndex]!) } },
      },
    },
  }), [slices, tooltip])

  return (
    <div className="oc-d">
      <div className="oc-t">{title}</div>
      <div className="oc-donut">
        <Chart config={config} height={158} ariaLabel={title} />
        <div className="oc-center">
          <div className="big num">{big}</div>
          <div className="sub">{sub}</div>
        </div>
      </div>
      <div className="oc-leg">
        {slices.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />{s.label} <b>{legend(s)}</b>
          </span>
        ))}
      </div>
    </div>
  )
}
