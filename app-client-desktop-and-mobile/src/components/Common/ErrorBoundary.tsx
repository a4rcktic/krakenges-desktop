import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getBranding } from '../../config/branding';

const appBrand = getBranding();

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${appBrand.shortName}] Unhandled UI error:`, error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        style={{
          backgroundColor: '#06070a',
          color: '#e5e7eb',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          width: '100vw',
          textAlign: 'center',
          padding: '24px',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: '22px', marginBottom: '8px' }}>{appBrand.appName} encontró un problema</h1>
        <p style={{ fontSize: '14px', opacity: 0.75, maxWidth: '480px', wordBreak: 'break-word' }}>
          Ocurrió un error inesperado en la interfaz.
        </p>
        <p style={{ fontSize: '12px', opacity: 0.7, maxWidth: '480px', wordBreak: 'break-word', fontFamily: 'monospace', background: 'rgba(255,255,255,0.05)', padding: '8px 12px', borderRadius: '4px' }}>
          {this.state.message}
        </p>
        <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              cursor: 'pointer',
              background: '#ffffff',
              color: '#000000',
              fontWeight: 600,
              border: 'none',
              borderRadius: '6px',
            }}
          >
            Recargar
          </button>
          <button
            onClick={() => {
              localStorage.clear();
              sessionStorage.clear();
              window.location.reload();
            }}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.1)',
              color: '#ffffff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
            }}
          >
            Restablecer Sesión
          </button>
        </div>
      </div>
    );
  }
}