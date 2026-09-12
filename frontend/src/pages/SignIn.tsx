import { useState, type FormEvent } from 'react'
import { useSession } from '../core/session'

/**
 * Two columns on a wide screen: who this belongs to on the left, the sign-in
 * on the right. Deliberately typographic - no photography. This is a clinical
 * tool holding HIV treatment records, and imagery of people would be
 * inappropriate against it however carefully chosen. (Carried over from the
 * original, along with the layout.)
 *
 * It is a <form>, which the original was not: that gets Enter-to-submit, the
 * browser's own required-field handling, and password managers, none of which
 * a bare button on a div provides.
 */
export default function SignIn() {
  const { signIn } = useSession()
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      await signIn(handle, password)
    } catch (e) {
      // The server deliberately does not say whether the account exists, so
      // whatever it sends back is shown as-is rather than reworded here.
      setErr(e instanceof Error ? e.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <aside className="login-brand">
        <img src="/brand/ecews-logo.png"
             alt="Excellence Community Education Welfare Scheme (ECEWS)" />
        <h2>Treatment Failure Monitoring Dashboard</h2>
        <p className="lede">
          Tracking the HIV treatment-failure and Enhanced Adherence Counselling
          cascade across the SPEED programme &mdash; from an unsuppressed viral
          load through counselling, repeat testing and the switch decision.
        </p>
        <div className="facts">
          <span>Supported states</span>
          <b>Delta &middot; Osun &middot; Ekiti</b>
        </div>
        <div className="foot">
          Excellence Community Education Welfare Scheme &middot; SPEED Programme<br />
          Authorised users only. Access is role-based and recorded.
        </div>
      </aside>

      <div className="login-form">
        <form className="login-card" onSubmit={submit}>
          <h1>Sign in</h1>
          <p>Use the account issued to you by your administrator.</p>

          {/* role=alert so a screen reader announces the failure; the original
              only toggled display, which is silent. */}
          {err && <div className="err" role="alert" style={{ display: 'block' }}>{err}</div>}

          <div className="field">
            <label htmlFor="em">Username</label>
            <input id="em" type="text" autoComplete="username" required
                   placeholder="your username" value={handle}
                   onChange={(e) => setHandle(e.target.value)} />
            <small style={{ color: 'var(--ink-3)', fontSize: 11 }}>
              Your email address still works.
            </small>
          </div>

          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" autoComplete="current-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          <button className="btn btn-solid" type="submit" disabled={busy}
                  style={{ width: '100%', marginTop: 8, padding: 11 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
