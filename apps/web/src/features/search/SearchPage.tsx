import type { MerchantSearchResult, TransactionSearchItem } from '@money/client';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Amount, Badge, Button, Callout, Card, DecimalField, EmptyState, Form, Loading, Row, SelectField, Stack, Table, Text, TextField, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import './search.css';
import { useMerchantLookup, useSearchAccounts, useTransactionSearch, type SearchFilters } from './data';

const DECIMAL = /^\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MATCH_LABEL: Record<MerchantSearchResult['matchType'], string> = { exact: 'Exact', alias: 'Alias', prefix: 'Starts with', partial: 'Contains', approximate: 'Approximate' };

/** The browser's time zone, so "2025-03-01" means the user's own local day */
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

type Draft = { merchantKey: string; merchantName: string; accountId: string; text: string; fromDate: string; toDate: string; currency: string; minAmount: string; maxAmount: string; direction: string };

const EMPTY: Draft = { merchantKey: '', merchantName: '', accountId: '', text: '', fromDate: '', toDate: '', currency: '', minAmount: '', maxAmount: '', direction: 'any' };

function draftFrom(params: URLSearchParams): Draft {
  const get = (k: string) => params.get(k) ?? '';
  return {
    merchantKey: get('merchantKey'),
    merchantName: get('merchantName'),
    accountId: get('accountId'),
    text: get('text'),
    fromDate: get('from'),
    toDate: get('to'),
    currency: get('currency'),
    minAmount: get('min'),
    maxAmount: get('max'),
    direction: ['out', 'in'].includes(get('direction')) ? get('direction') : 'any',
  };
}

function paramsFrom(d: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string) => {
    if (v.trim()) out[k] = v.trim();
  };
  set('merchantKey', d.merchantKey);
  set('merchantName', d.merchantName);
  set('accountId', d.accountId);
  set('text', d.text);
  set('from', d.fromDate);
  set('to', d.toDate);
  set('currency', d.currency.toUpperCase());
  set('min', d.minAmount);
  set('max', d.maxAmount);
  if (d.direction !== 'any') out.direction = d.direction;
  out.go = '1';
  return out;
}

function validate(d: Draft): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (d.fromDate && !DATE.test(d.fromDate)) errors.fromDate = 'Use YYYY-MM-DD.';
  if (d.toDate && !DATE.test(d.toDate)) errors.toDate = 'Use YYYY-MM-DD.';
  if (d.fromDate && d.toDate && DATE.test(d.fromDate) && DATE.test(d.toDate) && d.fromDate > d.toDate) errors.toDate = 'The end date is before the start date.';
  if (d.minAmount && !DECIMAL.test(d.minAmount)) errors.minAmount = 'Enter a positive number, e.g. 50 or 49.95.';
  if (d.maxAmount && !DECIMAL.test(d.maxAmount)) errors.maxAmount = 'Enter a positive number, e.g. 200.';
  if ((d.minAmount || d.maxAmount) && !/^[A-Za-z]{3}$/.test(d.currency)) errors.currency = 'Amounts need a currency, e.g. AUD. Currencies are never mixed.';
  else if (d.currency && !/^[A-Za-z]{3}$/.test(d.currency)) errors.currency = 'Use a 3-letter code, e.g. AUD.';
  return errors;
}

function useDebounced(value: string, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function MerchantPicker({ draft, setDraft }: { draft: Draft; setDraft: (patch: Partial<Draft>) => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const lookup = useMerchantLookup(debounced);

  if (draft.merchantKey) {
    return (
      <Stack gap={1}>
        <Text size="sm">Merchant</Text>
        <Row gap={2} align="center">
          <Badge tone="accent" title={draft.merchantKey}>
            {draft.merchantName || draft.merchantKey}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setDraft({ merchantKey: '', merchantName: '' })}>
            Clear merchant
          </Button>
        </Row>
      </Stack>
    );
  }
  const items = lookup.data?.items ?? [];
  return (
    <Stack gap={2}>
      <TextField label="Merchant" hint="Type a name, then choose the exact merchant. Similar names stay separate." value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      {query.trim().length >= 2 && lookup.isError && <ApiErrorCallout error={lookup.error} title="Could not look up merchants" />}
      {query.trim().length >= 2 && lookup.data && items.length === 0 && (
        <Text tone="muted" size="sm">
          No merchant matches “{query.trim()}”.
        </Text>
      )}
      {items.length > 0 && (
        <ul className="search__candidates" aria-label="Matching merchants">
          {items.map((m) => (
            <li key={m.merchantKey}>
              <Button size="sm" onClick={() => setDraft({ merchantKey: m.merchantKey, merchantName: m.name })}>
                {m.name}
              </Button>{' '}
              <Badge title="How closely the name matches. Confirm anything other than exact.">{MATCH_LABEL[m.matchType]}</Badge>{' '}
              <Text as="span" size="xs" tone="muted">
                {m.transactionCount} transaction{m.transactionCount === 1 ? '' : 's'}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

const formatWhen = (item: TransactionSearchItem, timezone: string) => {
  // Manual rows carry a plain local date; Up rows a UTC timestamp read in the search time zone
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return item.date;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.date));
  } catch {
    return item.date.slice(0, 10);
  }
};

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const applied = draftFrom(params);
  const [draft, setDraftState] = useState<Draft>(applied);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const accounts = useSearchAccounts();
  // Back/Forward and same-route navigation change the URL: show the filters that produced the results
  const urlKey = params.toString();
  useEffect(() => {
    setDraftState(draftFrom(new URLSearchParams(urlKey)));
    setErrors({});
  }, [urlKey]);
  const timezone = browserTimezone();
  const setDraft = (patch: Partial<Draft>) => setDraftState((d) => ({ ...d, ...patch }));

  const filters: SearchFilters | null =
    params.get('go') === '1'
      ? {
          merchantKey: applied.merchantKey || undefined,
          accountId: applied.accountId || undefined,
          text: applied.text || undefined,
          fromDate: applied.fromDate || undefined,
          toDate: applied.toDate || undefined,
          currency: applied.currency || undefined,
          minAmount: applied.minAmount || undefined,
          maxAmount: applied.maxAmount || undefined,
          direction: applied.direction as SearchFilters['direction'],
          timezone,
        }
      : null;
  const search = useTransactionSearch(filters);
  const pages = search.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const summary = pages[0]?.summary;
  const accountName = (id: string) => accounts.data?.items.find((a) => a.id === id)?.name ?? 'Account';

  const columns: Column<TransactionSearchItem>[] = [
    { key: 'date', nowrap: true, header: 'Date', render: (tx) => formatWhen(tx, timezone) },
    {
      key: 'what',
      header: 'Merchant / description',
      render: (tx) => (
        <span>
          {tx.merchant ?? tx.note ?? 'No description'}
          {tx.merchant && tx.note && (
            <Text tone="muted" size="xs">
              {tx.note}
            </Text>
          )}
        </span>
      ),
    },
    {
      key: 'account',
      header: 'Account',
      render: (tx) => (tx.source === 'manual' ? <Link to={`/accounts/${tx.accountId}/transactions/${tx.id}`}>{accountName(tx.accountId)}</Link> : accountName(tx.accountId)),
    },
    {
      key: 'status',
      header: 'Status',
      render: (tx) => (
        <Row gap={1}>
          <Badge tone={tx.status === 'HELD' ? 'warning' : 'neutral'}>{tx.status === 'HELD' ? 'Held' : 'Settled'}</Badge>
          <Badge>{tx.source === 'up' ? 'Up' : 'Manual'}</Badge>
        </Row>
      ),
    },
    { key: 'amount', header: 'Amount', numeric: true, render: (tx) => <Amount value={tx.amount} currency={tx.currency} signed /> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Search" subtitle="Find transactions by merchant, account, date and amount. The server does the filtering, so large histories stay fast." />
      <Card title="Filters">
        <Form
          label="Search transactions"
          onSubmit={() => {
            const found = validate(draft);
            setErrors(found);
            if (Object.keys(found).length === 0) setParams(paramsFrom(draft));
          }}
        >
          <Stack gap={3}>
            <MerchantPicker draft={draft} setDraft={setDraft} />
            <SelectField label="Account" value={draft.accountId} onChange={(e) => setDraft({ accountId: e.target.value })}>
              <option value="">All accounts</option>
              {(accounts.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.source === 'up' ? 'Up' : 'Manual'}, {a.currency}
                  {a.visible ? '' : ', hidden'})
                </option>
              ))}
            </SelectField>
            <TextField label="Description contains" hint="Free text in the description or message. Separate from the merchant." value={draft.text} onChange={(e) => setDraft({ text: e.target.value })} />
            <Row gap={3} wrap>
              <TextField label="From date" placeholder="YYYY-MM-DD" value={draft.fromDate} error={errors.fromDate} onChange={(e) => setDraft({ fromDate: e.target.value })} />
              <TextField label="To date" placeholder="YYYY-MM-DD" value={draft.toDate} error={errors.toDate} onChange={(e) => setDraft({ toDate: e.target.value })} />
            </Row>
            <Text tone="muted" size="xs">
              Dates are inclusive days in your time zone ({timezone}). Either end can be left empty.
            </Text>
            <Row gap={3} wrap>
              <DecimalField label="Min amount" value={draft.minAmount} error={errors.minAmount} onChange={(e) => setDraft({ minAmount: e.target.value })} />
              <DecimalField label="Max amount" value={draft.maxAmount} error={errors.maxAmount} onChange={(e) => setDraft({ maxAmount: e.target.value })} />
              <TextField label="Currency" placeholder="AUD" maxLength={3} value={draft.currency} error={errors.currency} onChange={(e) => setDraft({ currency: e.target.value })} />
              <SelectField label="Direction" value={draft.direction} onChange={(e) => setDraft({ direction: e.target.value })}>
                <option value="any">Money in and out</option>
                <option value="out">Money out (purchases)</option>
                <option value="in">Money in (refunds, deposits)</option>
              </SelectField>
            </Row>
            <Text tone="muted" size="xs">
              Amounts compare the size of a transaction, so 50 matches a 50 purchase and a 50 refund. Use direction to tell them apart.
            </Text>
            <Row gap={2}>
              <Button type="submit" variant="primary">
                Search
              </Button>
              <Button
                onClick={() => {
                  setDraftState(EMPTY);
                  setErrors({});
                  setParams({}, { replace: true });
                }}
              >
                Reset
              </Button>
            </Row>
          </Stack>
        </Form>
      </Card>

      {filters === null && <EmptyState title="Search your transactions">Choose a merchant, an account or a date range, then press Search.</EmptyState>}
      {filters !== null && search.isPending && <Loading label="Searching…" />}
      {search.isError && <ApiErrorCallout error={search.error} title="Search failed" />}
      {summary && (
        <Card title={`${summary.totalCount} match${summary.totalCount === 1 ? '' : 'es'}`} flush={items.length > 0}>
          {summary.totalCount === 0 && <EmptyState title="No transactions match">Try widening the dates or amounts, or clearing the merchant.</EmptyState>}
          {summary.totalCount > 0 && (
            <>
              <Stack gap={2}>
                {summary.byCurrency.map((c) => (
                  <Row key={c.currency} gap={4} wrap>
                    <Text as="span" size="sm">
                      {c.currency} · {c.count}
                    </Text>
                    <Text as="span" size="sm" tone="muted">
                      Out
                    </Text>
                    <Amount value={c.moneyOut} currency={c.currency} />
                    <Text as="span" size="sm" tone="muted">
                      In
                    </Text>
                    <Amount value={c.moneyIn} currency={c.currency} />
                    <Text as="span" size="sm" tone="muted">
                      Net
                    </Text>
                    <Amount value={c.net} currency={c.currency} signed />
                  </Row>
                ))}
              </Stack>
              <Table label="Search results" columns={columns} rows={items} rowKey={(tx) => `${tx.source}-${tx.id}`} />
              <Row justify="between" align="center">
                <Text tone="muted" size="sm">
                  Showing {items.length} of {summary.totalCount}
                </Text>
                {search.hasNextPage && (
                  <Button onClick={() => void search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                    {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </Row>
            </>
          )}
        </Card>
      )}
      {pages[0]?.matchedMerchants && pages[0].matchedMerchants.length > 0 && (
        <Callout tone="info" title="Matched merchants">
          {pages[0].matchedMerchants.map((m) => m.name).join(', ')}
        </Callout>
      )}
    </Stack>
  );
}
