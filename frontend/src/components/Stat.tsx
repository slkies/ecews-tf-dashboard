export type Tone = 'good' | 'warn' | 'bad' | undefined

/**
 * One headline figure with its denominator underneath.
 *
 * The note is not decoration: a percentage without its denominator is how "80%
 * completed EAC" turns out to be four clients out of five. Every tile that
 * shows a rate says what it is a rate of.
 */
export default function Stat({ k, v, note, tone }: {
  k: string
  v: string
  note?: string
  tone?: Tone
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="k">{k}</div>
      <div className="v num">{v}</div>
      {note && <div className="n">{note}</div>}
    </div>
  )
}
