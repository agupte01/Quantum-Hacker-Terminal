import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          color: '#ff4444', background: '#0d0d0d', padding: 32,
          fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap'
        }}>
          <div style={{ color: '#00ff88', marginBottom: 16 }}>⚠ RUNTIME ERROR</div>
          {String(this.state.error)}
          {'\n\n'}
          {this.state.error?.stack}
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
