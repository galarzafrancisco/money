import type { UpAccount } from '@money/client';
import { useState } from 'react';
import { Link } from 'react-router';
import { Amount, Badge, Card, Checkbox, Row, Swatch, Table, Text } from '../../ui';
import { useCategories } from '../categories/data';
import { useUpAccounts, useUpStatus } from './data';

/**
 * Imported Up accounts on the Accounts page. Only the accounts the user chose
 * are listed; "Show all" is a deliberate toggle. They are labelled "Up" and
 * kept apart from the manual accounts above: balances are never added together.
 */
export function UpAccountsSummary() {
  const status = useUpStatus();
  const [showAll, setShowAll] = useState(false);
  const accounts = useUpAccounts(showAll ? 'all' : 'visible', status.data?.status === 'active');
  const categories = useCategories();
  if (status.data?.status !== 'active') return null;
  const hidden = status.data.accounts.hidden;
  const byId = new Map((categories.data ?? []).map((c) => [c.id, c]));

  return (
    <Card title="Up accounts (imported)" flush>
      {accounts.data && accounts.data.length === 0 && (
        <Text tone="muted">None selected yet. <Link to="/connections">Choose which Up accounts to show</Link>.</Text>
      )}
      {accounts.data && accounts.data.length > 0 && (
        <Table<UpAccount>
          label="Up accounts"
          rows={accounts.data}
          rowKey={(a) => a.id}
          columns={[
            { key: 'name', header: 'Account', render: (a) => <span>{a.displayName} <Badge title="Imported from Up, read-only">Up</Badge>{!a.visible && <> <Badge tone="warning">Hidden</Badge></>}</span> },
            { key: 'category', header: 'Category', render: (a) => { const c = a.categoryId ? byId.get(a.categoryId) : undefined; return c ? <span><Swatch color={c.color} /> {c.name}</span> : <Text tone="muted" size="sm" as="span">Uncategorized</Text>; } },
            { key: 'balance', header: 'Balance', numeric: true, render: (a) => <Amount value={a.balance} currency={a.currency} /> },
          ]}
        />
      )}
      <Row gap={3} align="center">
        <Checkbox label="Show all Up accounts" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        <Text tone="muted" size="sm" as="span">{hidden} hidden · <Link to="/connections">Manage</Link></Text>
      </Row>
    </Card>
  );
}
