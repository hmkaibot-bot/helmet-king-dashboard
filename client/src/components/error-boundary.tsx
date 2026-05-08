import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors so the entire app does not unmount
 * (which would result in a blank/black screen with no diagnostics).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to console so devs can find the stack
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render error:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <div className="flex items-center gap-2 text-red-400 font-medium mb-2">
            <AlertTriangle className="h-4 w-4" />
            <span>頁面載入失敗 / Page failed to render</span>
          </div>
          <div className="text-muted-foreground mb-2">
            {error.message || String(error)}
          </div>
          {error.stack && (
            <pre className="text-[10px] text-muted-foreground/80 whitespace-pre-wrap overflow-auto max-h-48 mb-3">
              {error.stack}
            </pre>
          )}
          <button
            onClick={this.reset}
            className="px-3 py-1.5 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs"
          >
            重試 / Retry
          </button>
        </div>
      </div>
    );
  }
}
