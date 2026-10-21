import type { ReactNode } from 'react';
import { Button, Callout, Card, Heading, Loading, Stack, Text } from '../ui';
import { authErrorMessage, useSession } from './session';
import './signed-out.css';

/** Shown when nobody is signed in. Sign-in is federated to Taico: there is no local login. */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const { state } = session;
  if (state.status === 'signedIn') return <>{children}</>;
  return (
    <main className="signed-out">
      <Card>
        <Stack>
          <Heading>Money</Heading>
          {state.status === 'loading' && <Loading label="Checking your session…" />}
          {state.status === 'error' && (
            <Callout tone="danger" title="Money is unreachable">
              {state.message}
            </Callout>
          )}
          {state.status === 'signedOut' && (
            <>
              {state.reason === 'expired' && <Callout tone="warning" title="Your session ended">Sign in again to continue where you left off.</Callout>}
              {state.reason === 'signed_out' && <Callout tone="success">You are signed out of Money.</Callout>}
              {state.authError && (
                <Callout tone="danger" title="Sign-in failed">
                  {authErrorMessage(state.authError)}
                </Callout>
              )}
              <Text tone="muted">Track your accounts, holdings and the activity you record. Money never moves money or places trades.</Text>
            </>
          )}
          {state.status !== 'loading' && (
            <div>
              <Button variant="primary" onClick={session.signIn}>
                Sign in with Taico
              </Button>
            </div>
          )}
        </Stack>
      </Card>
    </main>
  );
}
