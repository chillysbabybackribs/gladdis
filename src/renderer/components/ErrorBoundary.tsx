import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in React render tree:', error, errorInfo)
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={containerStyle}>
          <div style={cardStyle}>
            <h2 style={headerStyle}>Something went wrong</h2>
            <p style={textStyle}>
              An unexpected error occurred in the application interface.
            </p>
            {this.state.error && (
              <pre style={preStyle}>
                {this.state.error.stack || this.state.error.message}
              </pre>
            )}
            <button
              style={buttonStyle}
              onClick={() => window.location.reload()}
            >
              Reload App
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const containerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  width: '100vw',
  backgroundColor: '#1e1e1e',
  color: '#f3f3f3',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  padding: '20px',
  boxSizing: 'border-box'
} as const

const cardStyle = {
  backgroundColor: '#2d2d2d',
  borderRadius: '8px',
  padding: '30px',
  maxWidth: '600px',
  width: '100%',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
  border: '1px solid #3e3e3e'
} as const

const headerStyle = {
  marginTop: 0,
  color: '#ff6b6b',
  fontSize: '22px'
} as const

const textStyle = {
  color: '#cccccc',
  fontSize: '14px',
  lineHeight: '1.5'
} as const

const preStyle = {
  backgroundColor: '#121212',
  padding: '15px',
  borderRadius: '4px',
  overflowX: 'auto',
  fontSize: '12px',
  fontFamily: 'monospace',
  color: '#8ab4f8',
  maxHeight: '200px',
  marginTop: '15px',
  border: '1px solid #232323'
} as const

const buttonStyle = {
  backgroundColor: '#007acc',
  color: '#ffffff',
  border: 'none',
  padding: '10px 20px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: '600',
  marginTop: '20px',
  transition: 'background-color 0.2s'
} as const
