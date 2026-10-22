import type { UpAccount } from '@money/client';
import { Amount, Badge, Checkbox, SelectField, Stack, Table, Text } from '../../ui';
import { useCategories } from '../categories/data';
import { useUpdateUpAccount } from './data';

/** Imported Up accounts: pick which show on the Accounts page and give each a category */
export function UpAccountsTable({ label, accounts }: { label: string; accounts: UpAccount[] }) {
  const categories = useCategories();
  const update = useUpdateUpAccount();
  return (
    <Table<UpAccount>
      label={label}
      rows={accounts}
      rowKey={(a) => a.id}
      columns={[
        {
          key: 'name',
          header: 'Up account',
          render: (a) => (
            <Stack gap={1}>
              <Text strong as="span">{a.displayName}</Text>
              <span>
                <Badge title="Imported from Up. Not part of your manual records.">Up</Badge> <Text tone="muted" size="sm" as="span">{a.accountType.toLowerCase()}</Text>
                {a.removedAt && <> <Badge tone="warning">No longer listed by Up</Badge></>}
              </span>
            </Stack>
          ),
        },
        { key: 'balance', header: 'Balance', numeric: true, render: (a) => <Amount value={a.balance} currency={a.currency} /> },
        {
          key: 'show',
          header: 'Show on Accounts page',
          render: (a) => (
            <Checkbox
              label={<span className="visually-hidden">Show {a.displayName} on the Accounts page</span>}
              checked={a.visible}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ accountId: a.id, body: { visible: e.target.checked } })}
            />
          ),
        },
        {
          key: 'category',
          header: 'Category',
          render: (a) => (
            <SelectField
              label={<span className="visually-hidden">Category for {a.displayName}</span>}
              value={a.categoryId ?? ''}
              disabled={update.isPending || categories.isPending}
              onChange={(e) => update.mutate({ accountId: a.id, body: { categoryId: e.target.value || null } })}
            >
              <option value="">Uncategorized</option>
              {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          ),
        },
      ]}
    />
  );
}
