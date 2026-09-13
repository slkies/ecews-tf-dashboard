import type { ChartConfiguration, ScriptableLineSegmentContext } from 'chart.js'
import { useMemo } from 'react'
import Chart from '../components/Chart'
import DonutCard, { type Slice } from '../components/DonutCard'
import Stat, { type Tone } from '../components/Stat'
import { DASH, fmt, fmtMonYY, pc, periodLabel } from '../core/format'
import type {
  Dist, FacilityRow, Overview as Ov, TimeMetrics,
} from '../core/overview'
import { cssVar, useChartPalette } from '../core/palette'

const tone = (v: number | null | undefined, bad: number, warn?: number): Tone => {
  if (v == null) return undefined
  if (v < bad) return 'bad'
  if (warn != null && v < warn) return 'warn'
  return 'good'
}

/** Axis presets shared with the existing charts: no grid, small ticks. */
const gx = { grid: { display: false }, ticks: { font: { size: 10 } } }
const gy = { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10 } } }

const SRC_KIND: Record<string, string> = {
  total: 'Total Unsuppressed register',
  treatment: 'Treatment line list',
  eac: 'EAC line list',
}

export default function Overview({ data, times }: {
  data: Ov | null
  times?: TimeMetrics | null
}) {
  const C = useChartPalette()

  // ── monthly incidence by sex ─────────────────────────────────────────
  const incidence = useMemo<ChartConfiguration | null>(() => {
    const w = data?.weekly
    if (!w?.months?.length) return null
    return {
      type: 'line',
      data: {
        labels: w.months.map(fmtMonYY),
        datasets: [
          { label: 'Female', data: w.female, borderColor: C.female,
            backgroundColor: 'rgba(27,73,101,.10)', fill: true, tension: 0.3,
            pointRadius: 3, pointBackgroundColor: C.female, borderWidth: 2.5 },
          { label: 'Male', data: w.male, borderColor: C.male,
            backgroundColor: 'rgba(98,182,203,.18)', fill: true, tension: 0.3,
            pointRadius: 3, pointBackgroundColor: C.male, borderWidth: 2.5 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: {
            footer: (items) =>
              `Total ${(items[0]?.parsed.y ?? 0) + (items[1]?.parsed.y ?? 0)}`,
          } },
        },
        scales: {
          x: gx,
          y: { ...gy, beginAtZero: true,
               title: { display: true, text: 'New unsuppressed results', font: { size: 10 } } },
        },
      },
    }
  }, [data, C])

  // ── monthly re-suppression trend, latest month provisional ──────────
  const resupp = useMemo<ChartConfiguration | null>(() => {
    const t = data?.resupp_trend
    if (!t?.months?.length) return null
    const lastIdx = t.months.length - 1
    const GREY = cssVar('--ink-3', '#8E9A94')
    // Dash and grey the final segment: the latest month's follow-ups are
    // freshly sampled and mostly not yet re-suppressed, so its rate is
    // provisional and must not read as a collapse.
    const prov = (col: string) => ({
      borderColor: (c: ScriptableLineSegmentContext) => c.p1DataIndex === lastIdx ? GREY : col,
      borderDash: (c: ScriptableLineSegmentContext) => c.p1DataIndex === lastIdx ? [6, 4] : undefined,
    })
    const line = (label: string, values: (number | null)[], col: string) => ({
      label, data: values, borderColor: col, backgroundColor: col, tension: 0.3,
      pointRadius: 3, pointBackgroundColor: col, borderWidth: 2.5, spanGaps: true,
      segment: prov(col),
    })
    return {
      type: 'line',
      data: { labels: t.months.map(fmtMonYY),
              datasets: [line('Female', t.female, C.female), line('Male', t.male, C.male)] },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: {
            label: (i) => `${i.dataset.label}: `
              + (i.parsed.y == null ? DASH : `${i.parsed.y.toFixed(1)}%`)
              + (i.dataIndex === lastIdx ? ' (provisional)' : ''),
            // The denominator travels with the rate: a month at 100% on two
            // results is not a good month.
            afterLabel: (i) => {
              const nn = i.dataset.label === 'Female' ? t.female_n : t.male_n
              return `n = ${fmt(nn[i.dataIndex])}`
            },
          } },
        },
        scales: {
          x: { ...gx, grid: { display: false } },
          y: { ...gy, max: 100, ticks: { callback: (v) => `${v}%`, font: { size: 10 } },
               title: { display: true, text: 'Re-suppressed', font: { size: 10 } } },
        },
      },
    }
  }, [data, C])

  // ── donut slices ─────────────────────────────────────────────────────
  const d = data?.demo
  const sexSlices = useMemo<Slice[]>(() => {
    if (!data) return []
    const unknown = Math.max(0, data.n - (d?.female ?? 0) - (d?.male ?? 0))
    const s: Slice[] = [
      { label: 'Female', value: d?.female ?? 0, color: C.female },
      { label: 'Male', value: d?.male ?? 0, color: C.male },
    ]
    if (unknown) s.push({ label: 'Unknown', value: unknown, color: C.rule })
    return s
  }, [data, d, C])
  const commencedSlices = useMemo<Slice[]>(() => {
    if (!data) return []
    const commenced = data.eac1 ?? 0
    // Same theme as the sex donut: deep blue achievement, light blue gap.
    return [
      { label: 'Commenced', value: commenced, color: C.female },
      { label: 'Not yet', value: Math.max(0, data.n - commenced), color: C.male },
    ]
  }, [data, C])

  if (!data || !data.n) {
    return <div className="empty">No data for this filter.</div>
  }

  const demo = d ?? ({} as Ov['demo'])
  const period = periodLabel(data)
  const postEacPct = data.completed ? (data.post_eac_vl / data.completed) * 100 : null
  const mo = demo.median_months_art
  const yrs = mo ? (mo / 12).toFixed(1) : null
  const sx = data.disagg?.sex ?? {}
  const fResupp = sx['Female']?.pct, mResupp = sx['Male']?.pct
  const stateBits = Object.entries(data.disagg?.state ?? {})
    .map(([k, v]) => `${k} ${pc(v.pct)}`).join(', ')

  // Incidence footer figures
  const w = data.weekly
  const F = w.female.reduce((a, b) => a + b, 0)
  const M = w.male.reduce((a, b) => a + b, 0)
  const T = F + M || 1
  const peak = Math.max(0, ...w.female.map((v, i) => v + (w.male[i] ?? 0)))

  const asofLong = data.as_of
    ? new Date(data.as_of).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : DASH

  return (
    <>
      {/* ── headline tiles ─────────────────────────────────────────── */}
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

      {/* ── time-to-event strip ────────────────────────────────────── */}
      <TimeStrip t={times} />

      {/* ── narrative ──────────────────────────────────────────────── */}
      <div className="panel narr">
        <div className="panel-h">
          <div className="eyebrow">Programme narrative</div>
          <h2>Treatment-failure cohort — {period}</h2>
        </div>
        <div className="narrative">
          <p>
            In {period}, {fmt(data.n)} treatment-failure episodes were recorded across{' '}
            {fmt(data.clients)} clients ({fmt(data.repeat_clients)} unsuppressed more than
            once). The cohort is {pc(demo.female_pct)} female ({fmt(demo.female)}) and{' '}
            {pc(demo.male_pct)} male ({fmt(demo.male)}); {pc(demo.adolescents_pct)} are
            adolescents (10–19, {fmt(demo.adolescents)}) and {pc(demo.paeds_pct)} are
            children under 10 ({fmt(demo.paeds)}). Median time on ART is{' '}
            {mo ? `${mo} months` : DASH}{yrs ? ` (${yrs} years)` : ''}, and{' '}
            {pc(demo.first_line_pct)} are on a first-line regimen with{' '}
            {pc(demo.second_line_pct)} ({fmt(demo.second_line)}) already on second-line.
          </p>
          <p>
            {pc(data.eac1_pct)} ({fmt(data.eac1)}) have commenced EAC, and{' '}
            {pc(data.completed_pct)} ({fmt(data.completed)}) of those have completed it.
            Median time to EAC commencement is{' '}
            {demo.median_time_to_eac != null ? `${demo.median_time_to_eac} days` : DASH},
            with an EAC lead time (commencement to follow-up sample) of about{' '}
            {demo.median_lead_months != null ? `${demo.median_lead_months} months` : DASH}.
          </p>
          <p>
            Among episodes with a follow-up viral load, the re-suppression rate is{' '}
            {pc(data.resupp_pct)}. {fmt(data.awaiting_switch)} episodes remain ≥ 1,000
            copies/ml and are awaiting DTC review (switch-committee candidates);{' '}
            {fmt(data.switched)} have moved to second- or third-line. Re-suppression is{' '}
            {pc(fResupp)} in females versus {pc(mResupp)} in males
            {stateBits ? `, and by state runs ${stateBits}.` : '.'} The clearest gap is
            coverage, not efficacy: only {pc(data.retest_pct)} of episodes have any
            follow-up VL on record, leaving {fmt(data.awaiting_retest)} untested.
          </p>
        </div>
      </div>

      {/* ── incidence + cohort at a glance ─────────────────────────── */}
      <div className="grid g2">
        <div className="panel col">
          <div className="panel-h">
            <h2>New unsuppressed results by month, by sex</h2>
            <p>Dated by result received at facility — the same clock the fiscal
               quarters use.</p>
          </div>
          {incidence
            ? <>
                <div className="chart-fill">
                  <Chart config={incidence} height={236}
                         ariaLabel="New unsuppressed results by month, split by sex" />
                </div>
                <div className="foot">
                  <span><b style={{ color: C.female }}>Female</b> {fmt(F)} ({(F / T * 100).toFixed(1)}%)</span>
                  <span><b style={{ color: C.maleInk }}>Male</b> {fmt(M)} ({(M / T * 100).toFixed(1)}%)</span>
                  <span><b>Mean/month</b> {Math.round(T / (w.months.length || 1))}</span>
                  <span><b>Peak</b> {peak}</span>
                </div>
              </>
            : <div className="empty">No dated results in this selection.</div>}
        </div>

        <div className="panel">
          <div className="panel-h">
            <div className="eyebrow">Demographics</div>
            <h2>Cohort at a glance</h2>
          </div>
          <div className="cohort-list">
            <Row l="Female" v={pc(demo.female_pct)} e={fmt(demo.female)} />
            <Row l="Adolescents 10–19" v={pc(demo.adolescents_pct)} e={fmt(demo.adolescents)} />
            <Row l="Children under 10" v={pc(demo.paeds_pct)} e={fmt(demo.paeds)} />
            <Row l="Median on ART" v={mo ? `${mo} mo` : DASH} e={yrs ? `${yrs} yr` : ''} />
            <Row l="First-line" v={pc(demo.first_line_pct)} e={fmt(demo.first_line)} />
            <Row l="Second-line" v={pc(demo.second_line_pct)} e={fmt(demo.second_line)} />
          </div>
        </div>
      </div>

      {/* ── EAC & outcome summary: donuts + state bars ─────────────── */}
      <div className="panel">
        <div className="panel-h">
          <h2>EAC &amp; outcome summary</h2>
          <p>How the unsuppressed cohort splits by sex, and how far it has moved through
             EAC. Follow-up VLs come from the clinical line lists, not the EAC sheet.</p>
        </div>
        <div className="oc-donuts">
          <DonutCard title="Total unsuppressed by sex" big={fmt(data.n)} sub="episodes"
                     slices={sexSlices}
                     tooltip={(s) => `${s.label} ${fmt(s.value)} (${(data.n ? s.value / data.n * 100 : 0).toFixed(1)}%)`}
                     legend={(s) => `${(data.n ? s.value / data.n * 100 : 0).toFixed(1)}%`} />
          <DonutCard title="Commenced EAC" big={pc(data.eac1_pct)}
                     sub={`${fmt(data.eac1)} of ${fmt(data.n)}`}
                     slices={commencedSlices}
                     tooltip={(s) => `${s.label} ${fmt(s.value)}`}
                     legend={(s) => fmt(s.value)} />
        </div>
        <div className="disagg-h">EAC commenced by state</div>
        {data.by_state?.length
          ? <div>
              {data.by_state.map((s) => (
                <div className="oc-state" key={s.state}>
                  <span className="sn">{s.state}</span>
                  <span className="st">
                    <i style={{ width: `${Math.min(s.eac1_pct ?? 0, 100).toFixed(1)}%`,
                                background: C.other }} />
                  </span>
                  <span className="sv">{pc(s.eac1_pct)}<em>{fmt(s.n)}</em></span>
                </div>
              ))}
            </div>
          : <div className="empty">No state breakdown for this filter.</div>}
      </div>

      {/* ── re-suppression trend + quarterly cascade ───────────────── */}
      <div className="panel">
        <div className="panel-h">
          <div className="eyebrow">Spec §4</div>
          <h2>Monthly re-suppression trend</h2>
          <p>Share of episodes with a follow-up VL that re-suppressed (&lt;&nbsp;1,000), by sex,
             dated on the follow-up sample. The latest month is provisional (dashed) — its
             follow-ups are freshly sampled and mostly not yet re-suppressed. Months with fewer
             than three results are left blank. The quarterly EAC cascade is tabulated below.</p>
        </div>
        {resupp
          ? <Chart config={resupp} height={290} ariaLabel="Monthly re-suppression rate by sex" />
          : <div className="empty">No follow-up results in this selection.</div>}

        <div className="disagg-h">EAC cascade by enrolment quarter</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Quarter</th><th className="r">Episodes</th>
                <th className="r">EAC commenced</th><th className="r">EAC completed</th>
                <th className="r">Follow-up VL</th><th className="r">Re-suppressed</th>
              </tr>
            </thead>
            <tbody>
              {data.progress?.map((p) => (
                <tr key={p.quarter}>
                  <td>{p.quarter}</td>
                  <td className="r num">{fmt(p.n)}</td>
                  <td className="r num">{fmt(p.eac1)} <em>{pc(p.eac1_pct)}</em></td>
                  <td className="r num">{fmt(p.completed)} <em>{pc(p.completed_pct)}</em></td>
                  <td className="r num">{fmt(p.retested)} <em>{pc(p.retest_pct)}</em></td>
                  <td className="r num">{fmt(p.resuppressed)} <em>{pc(p.resupp_pct)}</em></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── facility tables ────────────────────────────────────────── */}
      <div className="grid g2">
        <div className="panel">
          <div className="panel-h">
            <h2>Top 10 facilities by volume</h2>
            <p>Where the burden sits.</p>
          </div>
          <FacilityTable rows={data.by_volume} />
        </div>
        <div className="panel">
          <div className="panel-h">
            <h2>Top 10 by EAC completion</h2>
            <p>Ranked among facilities with at least {data.min_vol} episodes — completion
               rates on a handful of clients are noise, not signal.</p>
          </div>
          <FacilityTable rows={data.best} />
        </div>
      </div>

      {/* ── facilities with volume but no EAC ───────────────────────── */}
      {data.zero_eac?.length ? (
        <div className="panel">
          <div className="panel-h">
            <h2>Facilities with volume but no EAC on record</h2>
            <p>These sites carry real caseload and show zero EAC sessions. The export
               cannot tell us whether the counselling did not happen or was not recorded
               — both need a call.</p>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Facility</th><th className="r">Episodes</th><th className="r">EAC sessions</th></tr>
              </thead>
              <tbody>
                {data.zero_eac.map((r) => (
                  <tr key={r.facility ?? DASH}>
                    <td>{r.facility ?? DASH}</td>
                    <td className="r num">{fmt(r.n)}</td>
                    <td className="r"><span className="tag bad">0</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* ── methodology + data sources ─────────────────────────────── */}
      <div className="panel">
        <div className="src-grid">
          <div>
            {/* Title and subtitle live INSIDE the left column so the right
                column starts flush with the top of the card. */}
            <div className="panel-h" style={{ marginBottom: 14 }}>
              <h2>Methodology &amp; data sources</h2>
              <p>How the numbers on this page are built, and the line lists they rest on.
                 Per-sheet data-quality checks live on the Data quality tab.</p>
            </div>
            <div className="disagg-h" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
              How these numbers are built
            </div>
            <ul className="src-meth">
              <li>The unit of analysis is the failure <b>episode</b> (S/N + index VL date + value),
                  never the client — {fmt(data.repeat_clients)} clients unsuppressed more than once.</li>
              <li>The cohort is a <b>quarterly open cohort</b> drawn from the Total Unsuppressed register.</li>
              <li><b>All viral loads</b>, index and follow-up, come from the clinical line lists —
                  never the EAC sheet.</li>
              <li>The <b>follow-up VL</b> is the next VL sampled after the index result was received.</li>
              <li><b>EAC completed</b> = sessions 1–3 recorded plus ≥30 days since session 3;{' '}
                  <b>post-EAC VL</b> = sessions 1–3 plus a sample on/after session 3.</li>
            </ul>
            <p className="src-note">Full definitions on the <b>Methodology</b> tab; per-sheet
               data-quality checks on the <b>Data quality</b> tab.</p>
          </div>
          <div>
            <div className="disagg-h" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
              Source line lists
            </div>
            <div className="prov"><b>Line list as of</b> {asofLong} · sets the fiscal quarter
               and the follow-up window.</div>
            {data.sources?.length
              ? <div className="tbl-scroll">
                  <table className="src-tbl">
                    <thead><tr><th>Sheet</th><th>Type</th><th className="r">Rows</th></tr></thead>
                    <tbody>
                      {data.sources.map((s) => (
                        <tr key={s.name}>
                          <td>{s.name}</td>
                          <td>{SRC_KIND[s.kind] ?? s.kind}
                              {s.censored && <> <span className="tag bad">censored</span></>}</td>
                          <td className="r num">{fmt(s.rows)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              : <p className="src-note">Source sheet list is unavailable for this upload.</p>}
          </div>
        </div>
      </div>
    </>
  )
}

/** One line of the cohort-at-a-glance list. */
function Row({ l, v, e }: { l: string; v: string; e?: string }) {
  return (
    <div className="row">
      <span className="l">{l}</span>
      <span className="v num">{v}{e ? <em>{e}</em> : null}</span>
    </div>
  )
}

function FacilityTable({ rows }: { rows: FacilityRow[] | undefined }) {
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr><th>Facility</th><th className="r">Episodes</th>
              <th className="r">EAC commenced</th><th className="r">EAC completed</th></tr>
        </thead>
        <tbody>
          {rows?.map((r, i) => (
            <tr key={`${r.facility ?? DASH}-${i}`}>
              <td>{r.facility ?? DASH}</td>
              <td className="r num">{fmt(r.n)}</td>
              <td className="r num">{fmt(r.eac1)} <em>{pc(r.eac1_pct)}</em></td>
              <td className="r num">{fmt(r.completed)} <em>{pc(r.completed_pct)}</em></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The time-to-event strip, from /api/time-metrics. Nothing renders until it arrives. */
function TimeStrip({ t }: { t?: TimeMetrics | null }) {
  if (!t || !Object.keys(t).length) return null
  const md = (k: Dist | null | undefined) => k?.median != null ? fmt(k.median) : DASH
  const iqr = (k: Dist | null | undefined) => k ? `IQR ${k.q1}–${k.q3}` : ''
  return (
    <div className="stats">
      <Stat k="Median time to EAC" v={`${md(t.time_to_eac)} d`}
            note={`index result → session 1 · ${iqr(t.time_to_eac)}`}
            tone={(t.time_to_eac?.median ?? 0) > 30 ? 'warn' : 'good'} />
      <Stat k="EAC lead time" v={`${md(t.eac_lead_time)} d`}
            note={`session 1 → follow-up sample · ${iqr(t.eac_lead_time)}`}
            tone={(t.eac_lead_time?.median ?? 0) > 120 ? 'warn' : undefined} />
      <Stat k="Time to re-suppression" v={`${md(t.time_to_resuppression)} d`}
            note={`session 1 → suppressed VL · ${iqr(t.time_to_resuppression)}`} />
      <Stat k="Months unsuppressed"
            v={t.months_unsuppressed?.median != null ? String(t.months_unsuppressed.median) : DASH}
            note={`index VL → line-list date · ${iqr(t.months_unsuppressed)}`} tone="warn" />
    </div>
  )
}
