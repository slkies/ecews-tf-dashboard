import type { ChartConfiguration } from 'chart.js'
import { useMemo } from 'react'
import Chart from '../components/Chart'
import Stat, { type Tone } from '../components/Stat'
import { fmt, fmtMonYY, pc, periodLabel } from '../core/format'
import type { Overview as Ov } from '../core/overview'

/** Brand green / slate, matching the existing charts. */
const FEMALE = '#08684E'
const MALE = '#468faf'

const tone = (v: number | null | undefined, bad: number, warn?: number): Tone => {
  if (v == null) return undefined
  if (v < bad) return 'bad'
  if (warn != null && v < warn) return 'warn'
  return 'good'
}

export default function Overview({ data }: { data: Ov | null }) {
  const incidence = useMemo<ChartConfiguration | null>(() => {
    if (!data?.weekly?.months?.length) return null
    return {
      type: 'bar',
      data: {
        labels: data.weekly.months.map(fmtMonYY),
        datasets: [
          { label: 'Female', data: data.weekly.female, backgroundColor: FEMALE },
          { label: 'Male', data: data.weekly.male, backgroundColor: MALE },
        ],
      },
      options: {
        maintainAspectRatio: false,
        // Stacked: the question is how many new unsuppressed results arrived
        // in a month, with the split inside it - not two series to compare.
        scales: { x: { stacked: true, grid: { display: false } },
                  y: { stacked: true, beginAtZero: true } },
        plugins: { legend: { position: 'bottom' } },
      },
    }
  }, [data])

  const resupp = useMemo<ChartConfiguration | null>(() => {
    const t = data?.resupp_trend
    if (!t?.months?.length) return null
    return {
      type: 'line',
      data: {
        labels: t.months.map(fmtMonYY),
        datasets: [
          { label: 'Female', data: t.female, borderColor: FEMALE,
            backgroundColor: FEMALE, spanGaps: false, tension: 0.3 },
          { label: 'Male', data: t.male, borderColor: MALE,
            backgroundColor: MALE, spanGaps: false, tension: 0.3 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, max: 100,
                       ticks: { callback: (v) => `${v}%` } },
                  x: { grid: { display: false } } },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              // The denominator travels with the rate. A month at 100% on two
              // results is not a good month, and the tooltip is where someone
              // checks before quoting it.
              label: (c) => {
                const n = (c.datasetIndex === 0 ? t.female_n : t.male_n)[c.dataIndex]
                const v = c.parsed.y
                return v == null ? `${c.dataset.label}: —`
                  : `${c.dataset.label}: ${v.toFixed(1)}% of ${fmt(n)}`
              },
            },
          },
        },
      },
    }
  }, [data])

  if (!data || !data.n) {
    return <div className="empty">No data for this filter.</div>
  }

  const d = data.demo ?? ({} as Ov['demo'])
  const period = periodLabel(data)
  const postEacPct = data.completed ? (data.post_eac_vl / data.completed) * 100 : null
  const months = d.median_months_art
  const years = months ? (months / 12).toFixed(1) : null

  return (
    <>
      <div className="stats">
        <Stat k="Index cohort" v={fmt(data.n)}
              note={`${fmt(data.clients)} clients · ${fmt(data.repeats)} repeat unsuppression episodes`} />
        <Stat k="Commenced EAC" v={pc(data.eac1_pct)}
              note={`${fmt(data.eac1)} of ${fmt(data.n)} · ${fmt(data.never_eac)} never started`}
              tone={tone(data.eac1_pct, 70)} />
        <Stat k="Completed EAC" v={pc(data.completed_pct)}
              note={`${fmt(data.completed)} of ${fmt(data.eac1)} commenced`}
              tone={tone(data.completed_pct, 0, 50)} />
        {/* Post-EAC VL is a DIFFERENT indicator from the follow-up VL: it
            requires sessions 1-3 and a sample on or after session 3. */}
        <Stat k="Post-EAC VL sample" v={pc(postEacPct)}
              note={`${fmt(data.post_eac_vl)} of ${fmt(data.completed)} who completed EAC`}
              tone={tone(postEacPct, 60)} />
        <Stat k="Follow-up VL done" v={pc(data.retest_pct)}
              note={`${fmt(data.awaiting_retest)} episodes with no later VL`}
              tone={tone(data.retest_pct, 50)} />
        <Stat k="Re-suppressed" v={pc(data.resupp_pct)}
              note={`${fmt(data.resuppressed)} of ${fmt(data.retested)} with a follow-up VL`}
              tone={tone(data.resupp_pct, 0, 70)} />
        <Stat k="Awaiting DTC review" v={fmt(data.awaiting_switch)}
              note={`of ${fmt(data.still_unsuppressed)} still ≥ 1,000 · ${fmt(data.prior_switch)} prior-switch · ${fmt(data.switched)} switched`}
              tone={data.awaiting_switch ? 'bad' : 'good'} />
      </div>

      <div className="panel">
        <div className="panel-h">
          <div className="eyebrow">Programme narrative</div>
          <h2>Treatment-failure cohort — {period}</h2>
        </div>
        <div className="narrative">
          <p>
            In {period}, <strong>{fmt(data.n)} treatment-failure episodes</strong> were
            recorded across <strong>{fmt(data.clients)} clients</strong>{' '}
            ({fmt(data.repeat_clients)} unsuppressed more than once). The cohort is{' '}
            <strong>{pc(d.female_pct)} female</strong> ({fmt(d.female)}) and {pc(d.male_pct)} male
            {' '}({fmt(d.male)}); <strong>{pc(d.adolescents_pct)} are adolescents</strong>{' '}
            (10–19, {fmt(d.adolescents)}) and {pc(d.paeds_pct)} are children under 10
            {' '}({fmt(d.paeds)}). Median time on ART is{' '}
            <strong>{months ? `${months} months` : '—'}{years ? ` (${years} years)` : ''}</strong>,
            and <strong>{pc(d.first_line_pct)} are on a first-line regimen</strong>.
          </p>
          <p>
            Of these, <strong>{pc(data.eac1_pct)} commenced EAC</strong> and{' '}
            {pc(data.completed_pct)} of those completed it. A follow-up viral load exists
            for {pc(data.retest_pct)}, of which <strong>{pc(data.resupp_pct)} re-suppressed</strong>.
            {' '}{fmt(data.still_unsuppressed)} episodes remain at or above 1,000 copies/mL,
            and <strong>{fmt(data.awaiting_switch)} are awaiting DTC review</strong>.
          </p>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel col">
          <div className="panel-h">
            <h2>New unsuppressed results by month, by sex</h2>
            <p>Dated by result received at facility — the same clock the fiscal
               quarters use.</p>
          </div>
          {incidence
            ? <Chart config={incidence} height={300}
                     ariaLabel="New unsuppressed results by month, split by sex" />
            : <div className="empty">No dated results in this selection.</div>}
        </div>

        <div className="panel">
          <div className="panel-h">
            <h2>Re-suppression by state</h2>
            <p>Of episodes with a follow-up viral load.</p>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>State</th><th className="r">Episodes</th>
                    <th className="r">Commenced EAC</th><th className="r">Re-suppressed</th></tr>
              </thead>
              <tbody>
                {data.by_state?.map((s) => (
                  <tr key={s.state}>
                    <td>{s.state}</td>
                    <td className="r num">{fmt(s.n)}</td>
                    <td className="r num">{pc(s.eac1_pct)}</td>
                    <td className="r num">{pc(s.resupp_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <div className="eyebrow">Spec §4</div>
          <h2>Monthly re-suppression trend</h2>
          <p>Share of episodes with a follow-up VL that re-suppressed (&lt;&nbsp;1,000),
             by sex, dated on the follow-up sample. Months with fewer than three
             results are left blank rather than drawn as 0% or 100%.</p>
        </div>
        {resupp
          ? <Chart config={resupp} height={290}
                   ariaLabel="Monthly re-suppression rate by sex" />
          : <div className="empty">No follow-up results in this selection.</div>}

        <div className="disagg-h">EAC cascade by enrolment quarter</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Quarter</th><th className="r">Episodes</th>
                <th className="r">Commenced</th><th className="r">Completed</th>
                <th className="r">Follow-up VL</th><th className="r">Re-suppressed</th>
              </tr>
            </thead>
            <tbody>
              {data.progress?.map((p) => (
                <tr key={p.quarter}>
                  <td>{p.quarter}</td>
                  <td className="r num">{fmt(p.n)}</td>
                  <td className="r num">{pc(p.eac1_pct)}</td>
                  <td className="r num">{pc(p.completed_pct)}</td>
                  <td className="r num">{pc(p.retest_pct)}</td>
                  <td className="r num">{pc(p.resupp_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h2>Top facilities by volume</h2>
          <p>Where the burden sits.</p>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Facility</th><th className="r">Episodes</th>
                  <th className="r">Commenced EAC</th></tr>
            </thead>
            <tbody>
              {data.by_volume?.slice(0, 10).map((f) => (
                <tr key={f.facility}>
                  <td>{f.facility}</td>
                  <td className="r num">{fmt(f.n)}</td>
                  <td className="r num">{pc(f.eac1_pct ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
