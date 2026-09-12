import { useSession } from './core/session'
import SignIn from './pages/SignIn'
import Shell from './shell/Shell'

export default function App() {
  const { me, ready } = useSession()

  // Until a stored token has been checked, showing the sign-in page would make
  // a signed-in user flash past a login screen on every reload.
  if (!ready) return null
  return me ? <Shell /> : <SignIn />
}
