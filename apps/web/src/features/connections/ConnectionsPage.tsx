import type { UpStatus } from '@money/client';
import { useState } from 'react';
import { Badge, Button, ButtonLink, Callout, Card, Checkbox, EmptyState, Form, Loading, Row, Stack, Text, TextField } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { UpAccountsTable } from './UpAccountsTable';
import { useConnectUp, useDisconnectUp, useSyncUp, useUpAccounts, useUpStatus } from './data';

const STATUS_LABEL: Record<UpStatus['status'], string> = { none: 'Not connected', active: 'Connected', rejected: 'Token rejected', disconnected: 'Disconnected' };

function ConnectForm({ reconnect }: { reconnect: boolean }) {
  const connect = useConnectUp();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title={reconnect ? 'Reconnect Up' : 'Connect Up'}>
      <Form
        label="Connect Up"
        onSubmit={() => {
          if (!token.trim()) return setError('Paste your Up personal access token.');
          setError(null);
          // The token is sent once. It is cleared from the page whatever the outcome.
          connect.mutate(token.trim(), { onSettled: () => setToken('') });
        }}
      >
        <Stack gap={3}>
          <Text tone="muted">
            Money reads your Up accounts and transactions so you can track them. It is read-only: Money can never move money, pay anyone or change anything at Up.
            Create a personal access token at <strong>api.up.com.au</strong> and paste it here. It is stored encrypted and never shown again.
          </Text>
          <TextField
            label="Up personal access token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            error={error}
          />
          <ApiErrorCallout error={connect.error} title="Could not connect to Up" />
          <Row justify="end">
            <Button type="submit" variant="primary" disabled={connect.isPending}>{connect.isPending ? 'Importing your accounts…' : 'Connect Up'}</Button>
          </Row>
        </Stack>
      </Form>
    </Card>
  );
}

function ConnectedPanel({ status }: { status: UpStatus }) {
  const sync = useSyncUp();
  const disconnect = useDisconnectUp();
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  // Selection mode starts when nothing is chosen yet and stays on until "Done", so ticking the first account does not hide the rest
  // null = not decided yet. It is decided once, so "Done" with nothing ticked really leaves every account hidden
  const [chooseState, setChooseState] = useState<boolean | null>(null);
  if (chooseState === null && status.accounts.total > 0) setChooseState(status.accounts.visible === 0);
  const choosing = chooseState === true;
  const setChoosing = setChooseState;
  const visible = useUpAccounts('visible');
  const all = useUpAccounts('all', showAll || choosing);
  const needsChoice = choosing;
  const hidden = status.accounts.hidden;
  const shown = needsChoice || showAll ? all : visible;

  return (
    <>
      <Card title="Up">
        <Stack gap={3}>
          <Row gap={2} align="center">
            <Badge tone={status.status === 'active' ? 'success' : 'warning'}>{STATUS_LABEL[status.status]}</Badge>
            <Text tone="muted" size="sm" as="span">
              {status.lastSyncAt ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}` : 'Not synced yet'}
              {status.webhookStatus === 'registered' ? ' · live updates on' : ' · live updates off, use Sync now'}
            </Text>
          </Row>
          {status.lastError && <Callout tone="danger" title="Last sync failed">Up reported: {status.lastError.code}.</Callout>}
          {status.hint && <Callout tone="info">{status.hint}</Callout>}
          <ApiErrorCallout error={sync.error} title="Sync failed" />
          <Row gap={2}>
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? 'Syncing…' : 'Sync now'}</Button>
            <Button variant="ghost" onClick={() => setConfirming(true)}>Disconnect</Button>
          </Row>
          {confirming && (
            <Callout tone="warning" title="Disconnect Up?">
              <Stack gap={2}>
                <Text>Money erases your token and stops syncing. Also revoke the token in Up so it can no longer be used.</Text>
                <Checkbox label="Also delete everything imported from Up" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                <ApiErrorCallout error={disconnect.error} title="Not disconnected" />
                <Row gap={2}>
                  <Button size="sm" variant="danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate(purge, { onSuccess: () => setConfirming(false) })}>Confirm disconnect</Button>
                  <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
                </Row>
              </Stack>
            </Callout>
          )}
        </Stack>
      </Card>

      <Card
        title={needsChoice ? 'Choose the accounts to show' : showAll ? 'All Up accounts' : 'Shown on your Accounts page'}
        flush
      >
        {shown.isPending && <Loading label="Loading Up accounts…" />}
        {shown.isError && <ApiErrorCallout error={shown.error} title="Could not load Up accounts" />}
        {shown.data && shown.data.length === 0 && <EmptyState title="No Up accounts shown">Turn on “Show all accounts” to pick which ones appear.</EmptyState>}
        {shown.data && shown.data.length > 0 && <UpAccountsTable label="Up accounts" accounts={shown.data} />}
      </Card>
      {needsChoice ? (
        <Row gap={3} align="center">
          <Text tone="muted" size="sm" as="span">Tick the accounts to show on your Accounts page. Unticked accounts are still imported and tracked.</Text>
          <Button variant="primary" onClick={() => setChoosing(false)}>Done</Button>
        </Row>
      ) : (
        <Row gap={3} align="center">
          <Checkbox label={`Show all accounts (${status.accounts.total})`} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <Text tone="muted" size="sm" as="span">{hidden} hidden · hidden accounts are still imported and tracked</Text>
        </Row>
      )}
      <ButtonLink to="/accounts" variant="ghost">Go to Accounts</ButtonLink>
    </>
  );
}

/** Settings surface for external connections. Today: the read-only Up! import (docs/up-integration.md) */
export function ConnectionsPage() {
  const status = useUpStatus();
  return (
    <>
      <PageHeader title="Connections" subtitle="Bring in data from other services. Connections are read-only: Money records and tracks, it never moves money." />
      {status.isPending && <Loading label="Loading connections…" />}
      {status.isError && <ApiErrorCallout error={status.error} title="Could not load connections" />}
      {status.data && !status.data.configured && (
        <Callout tone="warning" title="Up import is not set up on this server">An administrator needs to configure an encryption key before Up can be connected.</Callout>
      )}
      {status.data?.configured && (status.data.status === 'active' ? <ConnectedPanel status={status.data} /> : (
        <>
          {status.data.status === 'rejected' && <Callout tone="danger" title="Up rejected your token">{status.data.hint ?? 'Create a new personal access token and reconnect.'}</Callout>}
          {status.data.status === 'disconnected' && <Callout tone="info">Up is disconnected. Previously imported data is kept. Connect again to resume syncing.</Callout>}
          <ConnectForm reconnect={status.data.status !== 'none'} />
        </>
      ))}
    </>
  );
}
