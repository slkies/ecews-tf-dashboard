import { useEffect, useState } from 'react'
import { api } from '../core/api'
import { useSession } from '../core/session'
import { useTheme } from '../core/theme'
import type { Summary } from '../core/types'
import BuildLine from './BuildLine'
import { GROUPS, NAV } from './nav'

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-GB')

export default function Shell() {
  const { me, signOut } = useSession()
  const { toggle } = useTheme()
  const [view, setView] = useState('overview')
  const [summary, setSummary] = useState<Summary | null>(null)

  const items = NAV.filter((n) => !n.adminOnly || me?.role === 'admin')

  useEffect(() => {
    let cancelled = false
    api<Summary>('/summary')
      .then((s) => { if (!cancelled) setSummary(s) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const asof = summary?.as_of
    ? new Date(summary.as_of).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="mark">EC</div>
          <div><b>TF Monitor</b><span>ECEWS&nbsp;SPEED</span></div>
        </div>

        <nav className="rail-nav" role="tablist">
          {GROUPS.map((g) => {
            const inGroup = items.filter((n) => n.group === g)
            if (!inGroup.length) return null
            return (
              <div key={g}>
                <div className="nav-lbl">{g}</div>
                {inGroup.map((n) => (
                  <button key={n.id} role="tab" aria-selected={view === n.id}
                          onClick={() => setView(n.id)}>
                    {n.label}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        {/* Provenance lives in the rail footer only - it used to repeat in the
            filter bar, which said the same thing twice on the same screen. */}
        <div className="rail-foot">
          Line list &middot; {asof}<br />
          {summary
            ? `${fmt(summary.n)} episodes · ${fmt(summary.clients)} clients`
            : ' '}
          <BuildLine />
        </div>
      </aside>

      <div className="railmain"><div className="inner">
        <header className="top">
          <div>
            <h1>Treatment Failure Monitoring Dashboard</h1>
            <div className="sub">ECEWS-SPEED &middot; Delta &middot; Osun &middot; Ekiti</div>
          </div>
          <div className="right">
            <div className="who">
              <b>{me?.name || me?.username || '—'}</b>
              <span>{me?.role}{me?.scope_state ? ` · ${me.scope_state}` : ''}</span>
            </div>
            <button className="btn" onClick={toggle} title="Toggle theme">&#9681;</button>
            <button className="btn" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <main className="wrap">
          <Placeholder view={view} />
        </main>
      </div></div>
    </div>
  )
}

/**
 * Every page except the shell is still served by the original app at /. This
 * says so plainly rather than showing an empty panel that looks broken.
 */
function Placeholder({ view }: { view: string }) {
  const label = NAV.find((n) => n.id === view)?.label ?? view
  return (
    <div style={{ padding: '48px 0', color: 'var(--ink-2)', maxWidth: '52ch' }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>{label}</h2>
      <p style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
        Not ported yet. This page is still live on the current dashboard at{' '}
        <a href="/" style={{ color: 'var(--green)' }}>the main site</a>, which is
        unchanged and remains the one to use for programme work.
      </p>
    </div>
  )
}
