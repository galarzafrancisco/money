import type { SaleAllocations } from '@money/client';
import { Amount, Badge, Stack, Table, Text } from '../../ui';

/** How a sale was split across purchase lots, exactly as the backend calculated it */
export function SaleAllocationsTable({ data }: { data: SaleAllocations }) {
  const c = data.currency;
  return (
    <Stack gap={3}>
      <Text size="sm" tone="muted">
        {data.lotSelection === 'SPECIFIC' ? 'Lots you chose for this sale.' : 'Matched first-in, first-out (FIFO): the oldest lots first.'} Figures are in {c}.
      </Text>
      <Table
        label="Sale allocations"
        rows={data.allocations}
        rowKey={(a) => a.lotId}
        columns={[
          { key: 'acquired', nowrap: true, header: 'Bought on', render: (a) => a.acquiredOn },
          { key: 'qty', header: 'Quantity', numeric: true, render: (a) => <Amount value={a.quantity} kind="quantity" /> },
          { key: 'unit', header: 'Unit cost', numeric: true, render: (a) => <Amount value={a.unitCostBase} currency={c} kind="rate" /> },
          { key: 'cost', header: 'Cost base', numeric: true, render: (a) => <Amount value={a.costBase} currency={c} /> },
          { key: 'fees', header: 'Fees share', numeric: true, render: (a) => <Amount value={a.fees} currency={c} /> },
          { key: 'gross', header: 'Gross proceeds', numeric: true, render: (a) => <Amount value={a.grossProceeds} currency={c} /> },
          { key: 'net', header: 'Net proceeds', numeric: true, render: (a) => <Amount value={a.proceeds} currency={c} /> },
          { key: 'gain', header: 'Gain', numeric: true, render: (a) => <Amount value={a.gain} currency={c} signed /> },
          {
            key: 'held',
            header: 'Held',
            render: (a) => (
              <span>
                {a.daysHeld} days {a.heldOverTwelveMonths && <Badge tone="accent">&gt; 12 months</Badge>}
              </span>
            ),
          },
        ]}
        footer={
          <tr>
            <td>Total</td>
            <td className="num"><Amount value={data.totals.quantity} kind="quantity" /></td>
            <td />
            <td className="num"><Amount value={data.totals.costBase} currency={c} /></td>
            <td className="num"><Amount value={data.totals.fees} currency={c} /></td>
            <td className="num"><Amount value={data.totals.grossProceeds} currency={c} /></td>
            <td className="num"><Amount value={data.totals.proceeds} currency={c} /></td>
            <td className="num"><Amount value={data.totals.gain} currency={c} signed /></td>
            <td />
          </tr>
        }
      />
      <ul>
        {data.notes.map((note) => (
          <li key={note}>
            <Text size="xs" tone="muted" as="span">{note}</Text>
          </li>
        ))}
      </ul>
    </Stack>
  );
}
