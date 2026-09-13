import { CircleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * A render failure degrades to a visible message in its own place, never to a
 * blank page.
 *
 * The permanent guard against the original's recurring "X is not defined"
 * crash, where one bad field in one panel took everything down - navigation
 * included - and looked like the data had failed to load.
 */
export default class ErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} render:`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{this.props.name} could not be displayed</AlertTitle>
          <AlertDescription>
            {this.state.error.message}. The data loaded correctly; this is a display fault.
          </AlertDescription>
        </Alert>
      )
    }
    return this.props.children
  }
}
