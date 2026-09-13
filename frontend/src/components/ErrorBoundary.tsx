import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A render failure degrades to a visible message in its own card, never to a
 * blank page.
 *
 * This is the permanent guard against the recurring "X is not defined"
 * full-page crash the original suffered: one bad field in one panel used to
 * take everything down, including the navigation, and it looked like the data
 * had failed to load. Now the panel says what happened and the rest of the
 * page carries on.
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
        <div className="err" style={{ display: 'block' }} role="alert">
          {this.props.name} render error: {this.state.error.message}. The data
          loaded correctly; this is a display fault.
        </div>
      )
    }
    return this.props.children
  }
}
