import { Component, type ReactNode } from 'react';

/** If anything in the app crashes, show what happened and a way back, never a blank screen. */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Forkspace crashed:', error, info.componentStack);
    (this as any).stack = info.componentStack ?? '';
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n${(this as any).stack ?? ''}`.slice(0, 4000);
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>Something went wrong</h1>
          <p>Forkspace hit an error and stopped drawing this screen. Your boards and agents are safe on your Mac.</p>
          <pre className="crash">{`${error.name}: ${error.message}`}</pre>
          <button className="btn primary block" onClick={() => location.reload()}>
            Reload
          </button>
          <button className="btn block" onClick={() => navigator.clipboard?.writeText(details)}>
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
