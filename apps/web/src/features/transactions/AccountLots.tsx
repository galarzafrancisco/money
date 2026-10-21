import type { Lot } from '@money/client';
import { useSearchParams } from 'react-router';
import { Amount, Badge, Card, Checkbox, EmptyState, Loading, Stack, Table, Text, type Column } from '../../ui';
import { useAccountContext } from '../accounts/AccountLayout';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useLots } from './data';

/** Purchase lots (one per buy) with what remains of each */
export function AccountLots() {
  const { account } = useAccountContext();
  const [params, setParams] = useSearchParams();
  const includeClosed = params.get('closed') === 'true';
  const lots = useLots(account.id, { includeClosed });

  const columns: Column<Lot>[] = [
    { key: 'symbol', header: 'Symbol', render: (l) => <Text strong as="span">{l.symbol}</Text> },
    { key: 'acquired', nowrap: true, header: 'Bought on', render: (l) => <span>{l.acquiredOn} <Text tone="muted" size="xs" as="span">#{l.sequence}</Text></span> },
    { key: 'status', header: 'Status', render: (l) => <Badge tone={l.status === 'OPEN' ? 'success' : 'neutral'}>{l.status === 'OPEN' ? 'Open' : 'Sold'}</Badge> },
    { key: 'original', header: 'Bought', numeric: true, render: (l) => <Amount value={l.originalQuantity} kind="quantity" /> },
    { key: 'remaining', header: 'Remaining', numeric: true, render: (l) => <Amount value={l.remainingQuantity} kind="quantity" /> },
    { key: 'unit', header: 'Unit cost', numeric: true, render: (l) => <Amount value={l.unitCostBase} currency={l.currency} kind="rate" /> },
    { key: 'cost', header: 'Remaining cost base', numeric: true, render: (l) => <Amount value={l.remainingCostBase} currency={l.currency} /> },
    { key: 'held', header: 'Held', render: (l) => <span>{l.daysHeld} days {l.heldOverTwelveMonths && <Badge tone="accent">&gt; 12 months</Badge>}</span> },
  ];

  return (
    <Card
      title="Lots"
      flush
      actions={<Checkbox label="Show sold lots" checked={includeClosed} onChange={(e) => setParams(e.target.checked ? { closed: 'true' } : {}, { replace: true })} />}
    >
      {lots.isPending && <Loading />}
      {lots.isError && <ApiErrorCallout error={lots.error} />}
      {lots.data && lots.data.lots.length === 0 && <EmptyState title="No lots">Each recorded buy creates a lot.</EmptyState>}
      {lots.data && lots.data.lots.length > 0 && (
        <Stack gap={3}>
          <Table label="Lots" columns={columns} rows={lots.data.lots} rowKey={(l) => l.lotId} />
          <ul>
            {lots.data.notes.map((n) => (
              <li key={n}><Text size="xs" tone="muted" as="span">{n}</Text></li>
            ))}
          </ul>
        </Stack>
      )}
    </Card>
  );
}
