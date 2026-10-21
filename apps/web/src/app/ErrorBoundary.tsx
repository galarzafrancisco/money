import { Component, type ReactNode } from 'react';
import { Button, Callout, Stack } from '../ui';

/** Catches unexpected rendering errors; expected API failures are handled by features */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Stack>
        <Callout tone="danger" title="Something went wrong">
          {this.state.error.message || 'An unexpected error occurred.'}
        </Callout>
        <div>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </Stack>
    );
  }
}
