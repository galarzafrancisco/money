import { Link } from 'react-router';
import { Badge, ButtonLink, Card, EmptyState, Stack, Table, Text } from '../../ui';
import { useAccountContext } from './AccountLayout';
import { ACCOUNT_TYPE_LABELS } from './data';

/** Buckets inside this account. Each has its own ledger; money moves between them with transfers. */
export function AccountSubaccounts() {
  const { account, accounts } = useAccountContext();
  const children = accounts.filter((a) => a.parentAccountId === account.id).sort((a, b) => a.name.localeCompare(b.name));
  const newLink = `/accounts/new?parent=${account.id}`;

  return (
    <Card title="Subaccounts" flush actions={<ButtonLink to={newLink} size="sm" variant="primary">New subaccount</ButtonLink>}>
      {children.length === 0 ? (
        <EmptyState title="No subaccounts" action={<ButtonLink to={newLink}>Create a subaccount</ButtonLink>}>
          Split this account into buckets, such as an emergency fund inside a savings account. Move money between them by recording a transfer.
        </EmptyState>
      ) : (
        <Stack gap={3}>
          <Table
            label="Subaccounts"
            rows={children}
            rowKey={(a) => a.id}
            columns={[
              { key: 'name', header: 'Name', render: (a) => <Link to={`/accounts/${a.id}`}>{a.name}</Link> },
              { key: 'type', header: 'Kind', render: (a) => <Badge>{ACCOUNT_TYPE_LABELS[a.type]}</Badge> },
              { key: 'currency', header: 'Reporting currency', render: (a) => a.reportingCurrency },
              { key: 'sub', header: 'Inside it', render: (a) => <Text size="sm" tone="muted" as="span">{accounts.filter((c) => c.parentAccountId === a.id).length || '—'}</Text> },
            ]}
          />
        </Stack>
      )}
    </Card>
  );
}
