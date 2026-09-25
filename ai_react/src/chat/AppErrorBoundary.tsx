// Keeps the chat alive when the app crashes. App.tsx renders <Chat /> itself,
// so a render crash there would take the chat down with it — and an agent
// without a chat cannot correct itself. This fallback therefore shows the
// error AND mounts the chat directly, independent of App.tsx.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRenderError } from '../agent/health.ts'
import { Chat } from './Chat.tsx'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRenderError(error, info.componentStack ?? '')
  }

  componentDidMount(): void {
    // A fixed app arrives as an HMR update; drop the fallback so the user does
    // not have to reload to see the repair.
    import.meta.hot?.on('vite:afterUpdate', this.reset)
  }

  componentWillUnmount(): void {
    import.meta.hot?.off('vite:afterUpdate', this.reset)
  }

  reset = (): void => {
    if (this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="app-crash">
        <div className="app-crash-banner">
          <strong>The app crashed while rendering.</strong>
          <pre>{this.state.error.message}</pre>
          <span>
            The chat below still works — ask the agent to fix it, or restore an older state at{' '}
            <a href="/recovery">/recovery</a>.
          </span>
        </div>
        <Chat />
      </div>
    )
  }
}
