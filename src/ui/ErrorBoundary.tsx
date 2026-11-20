import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// T5: белый экран без диагностики хуже ошибки — показываем причину и выход
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crash:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="center-page">
          <div className="card" style={{ maxWidth: 520 }}>
            <h2>Что-то сломалось</h2>
            <p className="muted small">{this.state.error.message}</p>
            <button className="btn btn-primary" onClick={() => { window.location.href = '/' }}>
              На главную
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
