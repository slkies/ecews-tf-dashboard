import { useState, type FormEvent } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useSession } from '@/core/session'

/**
 * Two columns on a wide screen: who this belongs to on the left, the sign-in
 * on the right. Deliberately typographic - no photography. This is a clinical
 * tool holding HIV treatment records, and imagery of people would be
 * inappropriate against it however carefully chosen.
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
      // its message is shown as-is rather than reworded here.
      setErr(e instanceof Error ? e.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[1.05fr_0.95fr]">
      <aside className="flex flex-col justify-center gap-5 border-b bg-sidebar px-6 py-8 lg:border-r lg:border-b-0 lg:px-14 lg:py-14">
        <img src="/brand/ecews-logo.png"
             alt="Excellence Community Education Welfare Scheme (ECEWS)"
             className="h-auto w-48 lg:w-[min(300px,68%)]" />
        <h1 className="max-w-[22ch] text-xl font-semibold tracking-tight text-balance lg:text-[26px] lg:leading-tight">
          Treatment Failure Monitoring Dashboard
        </h1>
        <p className="max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
          Tracking the HIV treatment-failure and Enhanced Adherence Counselling
          cascade across the SPEED programme, from an unsuppressed viral load
          through counselling, repeat testing and the switch decision.
        </p>
        <div className="hidden lg:block">
          <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Supported states
          </div>
          <div className="text-lg font-semibold tracking-tight">Delta · Osun · Ekiti</div>
        </div>
        <p className="hidden border-t pt-3 text-xs leading-relaxed text-muted-foreground lg:block">
          Excellence Community Education Welfare Scheme · SPEED Programme<br />
          Authorised users only. Access is role-based and recorded.
        </p>
      </aside>

      <div className="flex items-start justify-center px-5 py-8 lg:items-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>Use the account issued to you by your administrator.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              {err && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{err}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="em" className="text-sm font-medium">Username</label>
                <Input id="em" type="text" autoComplete="username" required
                       placeholder="your username" value={handle}
                       onChange={(e) => setHandle(e.target.value)} />
                <p className="text-xs text-muted-foreground">Your email address still works.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="pw" className="text-sm font-medium">Password</label>
                <Input id="pw" type="password" autoComplete="current-password" required
                       value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
                {busy && <Spinner />}
                {busy ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
