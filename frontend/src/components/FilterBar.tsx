import { useFilters, visibleOptions, type FilterKey } from '../core/filters'
import { fmt, fmtMonYY } from '../core/format'
import MultiSelect, { type Option } from './MultiSelect'

const plain = (v: string): Option => ({ value: v, label: v })

/** Label, tooltip and order of the bar. The order is the reading order: when,
 *  then where, then who, then what. */
const FIELDS: { key: FilterKey; label: string; title?: string }[] = [
  { key: 'fy',       label: 'Fiscal year' },
  { key: 'quarter',  label: 'Enrolment quarter' },
  { key: 'month',    label: 'Month',
    title: 'Month the index result reached the facility' },
  { key: 'state',    label: 'State' },
  { key: 'lga',      label: 'LGA (service)', title: 'LGA of the treating facility' },
  { key: 'lga_res',  label: 'LGA (residence)',
    title: 'Where the client lives — the unit for transmission and outreach targeting' },
  { key: 'facility', label: 'Facility' },
  { key: 'sex',      label: 'Sex' },
  { key: 'age_band', label: 'Age band' },
  { key: 'plan',     label: 'Treatment plan' },
]

export default function FilterBar() {
  const { options, error, selection, get, set, reset, active } = useFilters()

  if (error) {
    return (
      <div className="notice warn">
        <h3>No data loaded</h3>
        An administrator needs to upload a workbook.
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>({error})</div>
      </div>
    )
  }
  if (!options) return null

  const avail = visibleOptions(options, selection)

  // Months come back newest first as YYYY-MM. Shown as 'Aug-26' but the VALUE
  // stays YYYY-MM, which is what the API filters on - the option text is for
  // reading, never for matching.
  //
  // The count is part of the label because the list is wildly uneven: the
  // register is cumulative, so recent months carry hundreds and the oldest
  // carry one or two. Picking a month blind and reading two clients as a
  // collapse is the mistake this prevents.
  const monthOptions: Option[] = options.months.map((m) => ({
    value: m.m,
    label: `${fmtMonYY(`${m.m}-01`)}${m.n == null ? '' : ` (${fmt(m.n)})`}`,
  }))

  return (
    <div className="filters">
      {FIELDS.map((f) => (
        <MultiSelect key={f.key} label={f.label} title={f.title}
                     options={f.key === 'month' ? monthOptions
                                                : avail[f.key].map(plain)}
                     value={get(f.key)}
                     onChange={(v) => set(f.key, v)} />
      ))}
      <div className="f f-btn">
        <label>&nbsp;</label>
        <button className="btn" onClick={reset} disabled={!active}
                title={active ? `Clear ${active} selection(s)` : 'Nothing to clear'}>
          Reset
        </button>
      </div>
    </div>
  )
}
