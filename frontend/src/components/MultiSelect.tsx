import { useEffect, useId, useRef, useState } from 'react'

export interface Option { value: string; label: string }

interface Props {
  label: string
  title?: string
  options: Option[]
  value: string[]
  onChange: (values: string[]) => void
}

/**
 * A checkbox menu behind a button.
 *
 * The original kept a hidden <select multiple> as the state and drew checkboxes
 * over it, because the rest of the page read `.options` and listened for
 * 'change'. Nothing does that here, so the select is gone and the values are
 * simply props - which removes the class of bug where the two copies of the
 * state disagreed.
 *
 * An empty selection means "All". That is not the same as nothing: it is the
 * absence of a restriction, and it is why "All" is a row that clears the others
 * rather than a value that gets sent.
 */
export default function MultiSelect({
  label, title, options, value, onChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const id = useId()

  // Click anywhere else, or press Escape, and the panel closes. Registered
  // only while open so the page is not listening to every click all day.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('click', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  // Selected values that are no longer on offer would filter to nothing while
  // the button still claimed they were chosen. Drop them.
  const allowed = new Set(options.map((o) => o.value))
  const chosen = value.filter((v) => allowed.has(v))

  const btnLabel = chosen.length === 0 ? 'All'
    : chosen.length <= 2
      ? chosen.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ')
      : `${chosen.length} selected`

  function toggle(v: string, on: boolean) {
    onChange(on ? [...chosen, v] : chosen.filter((x) => x !== v))
  }

  return (
    <div className="f">
      <label htmlFor={id} title={title}>{label}</label>
      <div className="ms" ref={box}>
        {/* The caption alone is half the information: a <label for> on a
            button replaces the button's own text, so a screen reader would
            say "Age band" and never the current value. aria-label carries
            both. (aria-labelledby referencing the button itself is legal and
            would read the same, but is unevenly implemented.) */}
        <button type="button" id={id} className={`ms-btn${chosen.length ? ' on' : ''}`}
                aria-expanded={open} aria-haspopup="true"
                aria-label={`${label}: ${btnLabel}`}
                title={chosen.length ? chosen.join(', ') : 'All'}
                onClick={() => setOpen((o) => !o)}>
          {btnLabel}
        </button>
        <div className="ms-menu" hidden={!open} role="group" aria-label={label}>
          <label className="ms-opt ms-all">
            <input type="checkbox" checked={chosen.length === 0}
                   onChange={() => onChange([])} />
            <span>All</span>
          </label>
          {options.map((o) => (
            <label className="ms-opt" key={o.value}>
              <input type="checkbox" checked={chosen.includes(o.value)}
                     onChange={(e) => toggle(o.value, e.target.checked)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
