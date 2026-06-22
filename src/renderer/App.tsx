import { Workspace } from './components/Workspace'
import { ErrorBoundary } from './components/ErrorBoundary'

export function App() {
  return (
    <ErrorBoundary>
      <div className="app">
        <Workspace />
      </div>
    </ErrorBoundary>
  )
}
