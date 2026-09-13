import { CircleAlert, Pin, PinOff, X } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup,
  ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSeparator,
  ComboboxTrigger,
} from '@/components/ui/combobox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  useFilters, visibleOptions, type FilterKey, type FilterOptions,
} from '@/core/filters'
import { fmt, fmtMonYY } from '@/core/format'
import { usePinnedFilters } from '@/core/use-pinned-filters'

interface Group { value: string; items: string[] }

/** Label, tooltip and reading order: when, then where, then who, then what. */
const FIELDS: { key: FilterKey; label: string; title?: string; search: string }[] = [
  { key: 'fy', label: 'Fiscal year', search: 'Search years' },
  { key: 'quarter', label: 'Enrolment quarter', search: 'Search quarters' },
  { key: 'month', label: 'Month', title: 'Month the index result reached the facility', search: 'Search months' },
  { key: 'state', label: 'State', search: 'Search states' },
  { key: 'lga', label: 'LGA (service)', title: 'LGA of the treating facility', search: 'Search LGAs' },
  { key: 'lga_res', label: 'LGA (residence)', title: 'Where the client lives, the unit for outreach targeting', search: 'Search LGAs' },
  { key: 'facility', label: 'Facility', search: 'Search facilities' },
  { key: 'sex', label: 'Sex', search: '' },
  { key: 'age_band', label: 'Age band', search: 'Search age bands' },
  { key: 'plan', label: 'Treatment plan', search: 'Search plans' },
]

/**
 * Group a list under the state each value belongs to, in the order the states
 * are offered. Facilities are searched by name but found by state, which is
 * how programme staff think about them.
 */
export function byState(values: string[], map: Record<string, string>, states: string[]): Group[] {
  const groups = new Map<string, string[]>()
  for (const v of values) {
    const s = map[v] ?? 'Other'
    groups.set(s, [...(groups.get(s) ?? []), v])
  }
  const order = [...states, 'Other']
  return [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([value, items]) => ({ value, items }))
}

function summaryOf(chosen: string[], show: (v: string) => string) {
  if (chosen.length === 0) return 'All'
  if (chosen.length === 1) return show(chosen[0]!)
  return `${chosen.length} selected`
}

/**
 * One filter: a button that opens a searchable list. Every filter is a list -
 * "paediatrics and adolescents" is two age bands - and an empty selection
 * means "no restriction", not "nothing".
 */
function MultiFilter({ label, title, search, items, groups, value, onChange, show = (v) => v }: {
  label: string
  title?: string
  search: string
  items?: string[]
  groups?: Group[]
  value: string[]
  onChange: (values: string[]) => void
  show?: (v: string) => string
}) {
  // Selections no longer on offer (after a parent filter changed) would filter
  // to nothing while the button still claimed them. Drop them from view.
  const allowed = useMemo(
    () => new Set(groups ? groups.flatMap((g) => g.items) : items ?? []), [items, groups])
  const chosen = value.filter((v) => allowed.has(v))
  const summary = summaryOf(chosen, show)

  const trigger: ReactElement = (
    <Button variant="outline" aria-label={`${label}: ${summary}`}
            className={cn('w-full justify-between px-2.5 font-normal',
                          chosen.length > 0 && 'border-primary/40 bg-accent text-accent-foreground')} />
  )
  const content = (list: ReactElement) => (
    <ComboboxContent className="w-72">
      <ComboboxInput showTrigger={false} placeholder={search} />
      <ComboboxEmpty>No matches.</ComboboxEmpty>
      {list}
    </ComboboxContent>
  )

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-xs font-medium text-muted-foreground" title={title}>{label}</span>
      {groups ? (
        <Combobox items={groups} multiple value={chosen} autoHighlight
                  itemToStringLabel={(v) => show(v as unknown as string)}
                  onValueChange={(v) => onChange(v as unknown as string[])}>
          <ComboboxTrigger render={trigger}><span className="truncate">{summary}</span></ComboboxTrigger>
          {content(
            <ComboboxList>
              {(group: Group, index: number) => (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel>{group.value}</ComboboxLabel>
                  <ComboboxCollection>
                    {(item: string) => <ComboboxItem key={item} value={item}>{show(item)}</ComboboxItem>}
                  </ComboboxCollection>
                  {index < groups.length - 1 && <ComboboxSeparator />}
                </ComboboxGroup>
              )}
            </ComboboxList>,
          )}
        </Combobox>
      ) : (
        <Combobox items={items ?? []} multiple value={chosen} autoHighlight
                  itemToStringLabel={show}
                  onValueChange={(v) => onChange(v as string[])}>
          <ComboboxTrigger render={trigger}><span className="truncate">{summary}</span></ComboboxTrigger>
          {content(
            <ComboboxList>
              {(item: string) => <ComboboxItem key={item} value={item}>{show(item)}</ComboboxItem>}
            </ComboboxList>,
          )}
        </Combobox>
      )}
    </div>
  )
}

/**
 * Pin or release the filter bar. Only offered where pinning applies (large
 * screens); the label says what clicking will do, and the pressed state says
 * what is true now.
 */
export function PinFiltersToggle() {
  const [pinned, setPinned] = usePinnedFilters()
  return (
    <Button variant="outline" size="sm" aria-pressed={pinned} onClick={() => setPinned(!pinned)}
            className="hidden lg:inline-flex"
            title={pinned
              ? 'The filters stay in view as you scroll. Click to let them scroll away.'
              : 'The filters scroll away with the page. Click to keep them in view.'}>
      {pinned ? <PinOff /> : <Pin />}
      {pinned ? 'Unpin filters' : 'Pin filters'}
    </Button>
  )
}

export default function FilterBar() {
  const { options, error, selection, get, set, reset, active } = useFilters()

  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>No data loaded</AlertTitle>
        <AlertDescription>An administrator needs to upload a workbook. ({error})</AlertDescription>
      </Alert>
    )
  }
  if (!options) return null

  return <Bar options={options} selection={selection} get={get} set={set} reset={reset} active={active} />
}

function Bar({ options, selection, get, set, reset, active }: {
  options: FilterOptions
  selection: ReturnType<typeof useFilters>['selection']
  get: (k: FilterKey) => string[]
  set: (k: FilterKey, v: string[]) => void
  reset: () => void
  active: number
}) {
  const avail = visibleOptions(options, selection)
  const [pinned] = usePinnedFilters()

  // Months arrive newest first as YYYY-MM. Shown as 'Aug-26 (312)', but the
  // VALUE stays YYYY-MM, which is what the API filters on. The count is there
  // because the register is cumulative and very uneven: recent months carry
  // hundreds, the oldest one or two, and a month picked blind reads as a collapse.
  const monthLabel = useMemo(() => {
    const m = new Map(options.months.map((x) => [x.m, `${fmtMonYY(`${x.m}-01`)} (${fmt(x.n)})`]))
    return (v: string) => m.get(v) ?? v
  }, [options.months])

  const controlFor = (f: (typeof FIELDS)[number]) => {
    const common = { label: f.label, title: f.title, search: f.search, value: get(f.key),
                     onChange: (v: string[]) => set(f.key, v) }
    switch (f.key) {
      case 'sex':
        return (
          <div key={f.key} className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground" id="sex-label">Sex</span>
            <ToggleGroup multiple variant="outline" spacing={0} aria-labelledby="sex-label"
                         value={get('sex')} onValueChange={(v) => set('sex', v as string[])}
                         className="w-full">
              {avail.sex.map((s) => (
                <ToggleGroupItem key={s} value={s} className="flex-1 data-[pressed]:bg-accent data-[pressed]:text-accent-foreground">
                  {s}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )
      case 'month':
        return <MultiFilter key={f.key} {...common} items={avail.month} show={monthLabel} />
      case 'facility':
        return <MultiFilter key={f.key} {...common}
                            groups={byState(avail.facility, options.facility_state ?? {}, options.states)} />
      case 'lga':
        return <MultiFilter key={f.key} {...common}
                            groups={byState(avail.lga, options.lga_state ?? {}, options.states)} />
      default:
        return <MultiFilter key={f.key} {...common} items={avail[f.key]} />
    }
  }

  const chips = FIELDS.flatMap((f) =>
    get(f.key).map((v) => ({ key: f.key, field: f.label, value: v,
                              text: f.key === 'month' ? monthLabel(v) : v })))

  return (
    // When pinned (the reader's choice, see use-pinned-filters), the bar sticks
    // below the header on large screens. The band sits flush under the 4rem
    // header and carries its own translucent ground: pinned with a gap, the
    // tiles scrolled visibly through the space between.
    <div className={cn('z-20 -mx-4 px-4 lg:-mx-6 lg:px-6',
                       pinned && 'lg:sticky lg:top-16 lg:bg-background/85 lg:py-3 lg:backdrop-blur-md')}
         data-pinned={pinned}>
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {FIELDS.map(controlFor)}
        </div>
        {active > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
            <span className="mr-1 text-xs text-muted-foreground">Filtered by</span>
            {chips.map((c) => (
              <span key={`${c.key}-${c.value}`}
                    className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-xs">
                <span className="text-muted-foreground">{c.field}:</span>
                <span className="font-medium">{c.text}</span>
                <button type="button" aria-label={`Remove ${c.field} ${c.text}`}
                        onClick={() => set(c.key, get(c.key).filter((x) => x !== c.value))}
                        className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">
              Reset all
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
