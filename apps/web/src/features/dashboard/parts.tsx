import type { Dashboard, ReportTotals } from '@money/client';
import { useState } from 'react';
import { Amount, Badge, Button, Callout, DecimalField, Form, Row, Stack, Text, type BadgeTone } from '../../ui';
import { isPositiveDecimal } from '../../lib/decimal';
import { CurrencyLines } from '../shared/CurrencyTotals';

type PriceStatus = Dashboard['shares']['tickers'][number]['priceStatus'];

/**
 * A figure in the display currency when the backend converted it; otherwise
 * one line per currency, never added together (guidelines §6.5).
 */
export function ConvertedAmount({ totals, part = 'total' }: { totals: ReportTotals; part?: 'cash' | 'holdings' | 'total' }) {
  if (totals.converted) return <Amount value={totals.converted[part]} currency={totals.converted.baseCurrency} />;
  return <CurrencyLines lines={totals.byCurrency.map((t) => ({ currency: t.currency, amount: t[part] }))} empty="0" />;
}

/** A backend percentage, or a dash explaining why there is none */
export function Percent({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <Text tone="muted" size="sm" as="span">
        <span title="Needs an exchange rate for every currency">—</span>
      </Text>
    );
  }
  return <Amount value={value} kind="percent" />;
}

const STATUS: Record<PriceStatus, { label: string; tone: BadgeTone; title: string }> = {
  MARKET: { label: 'Market price', tone: 'neutral', title: 'A recent price from the market-price provider' },
  STALE: { label: 'Stale price', tone: 'warning', title: 'The latest price is more than a few days old' },
  MOCK: { label: 'Mock price', tone: 'warning', title: 'Made-up development price, not market data' },
  COST_FALLBACK: { label: 'At cost, no price', tone: 'danger', title: 'No usable price, so valued at cost base' },
};

export function PriceStatusBadge({ status }: { status: PriceStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} title={s.title}>
      {s.label}
    </Badge>
  );
}

/** Every percentage present, so a part-to-whole chart is meaningful */
export function allPercents<T>(rows: readonly T[], percent: (row: T) => string | null): boolean {
  return rows.length > 0 && rows.every((r) => percent(r) !== null);
}

/** How the figures were valued and converted: rates with their source and time, gaps, and warnings */
export function DataQuality({ dashboard, onManualRates }: { dashboard: Dashboard; onManualRates: (rates: string | null) => void }) {
  const { fx, valuation } = dashboard;
  const hasManual = fx.rates.some((r) => r.source === 'manual');
  return (
    <Stack gap={3}>
      <Row gap={2}>
        {valuation.status === 'COMPLETE' ? (
          <Badge tone="success" title="Every holding has a recent price and every currency is converted">
            Complete valuation
          </Badge>
        ) : (
          <Badge tone="warning" title="Some holdings are at cost or on stale prices, or a currency is not converted">
            Partial valuation
          </Badge>
        )}
        {valuation.usesMockPrices && (
          <Badge tone="warning" title="Made-up development data, not market data">
            Includes mock data
          </Badge>
        )}
        {fx.rates.map((r) => (
          <Text key={r.currency} size="sm" tone="muted" as="span">
            1 {r.currency} = <Amount value={r.rate} kind="rate" /> {fx.displayCurrency}{' '}
            {r.source === 'manual' ? '(your rate)' : `(${r.isMock ? 'mock rate' : r.provider}${r.asOf ? `, ${r.asOf.slice(0, 16).replace('T', ' ')} UTC` : ''}${r.isStale ? ', last known rate: provider unreachable' : ''})`}
          </Text>
        ))}
        {hasManual && (
          <Button size="sm" variant="ghost" onClick={() => onManualRates(null)}>
            Use market rates
          </Button>
        )}
      </Row>
      {fx.missing.length > 0 && <MissingRates dashboard={dashboard} onManualRates={onManualRates} />}
      {(valuation.costFallback > 0 || valuation.stalePriced > 0) && (
        <Text size="sm" tone="muted">
          {valuation.holdings} holding(s): {valuation.marketPriced + valuation.mockPriced} priced, {valuation.stalePriced} on a price older than {valuation.stalePriceDays} days,{' '}
          {valuation.costFallback} at cost base for lack of a price.
        </Text>
      )}
      {dashboard.warnings.length > 0 && (
        <details>
          <summary>
            <Text size="sm" as="span">
              {dashboard.warnings.length} note(s) about these figures
            </Text>
          </summary>
          <ul>
            {dashboard.warnings.map((w) => (
              <li key={w}>
                <Text size="sm" as="span">
                  {w}
                </Text>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Stack>
  );
}

/** No rate for some currency: totals are shown per currency until the user supplies one */
function MissingRates({ dashboard, onManualRates }: { dashboard: Dashboard; onManualRates: (rates: string | null) => void }) {
  const { fx } = dashboard;
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const entries = fx.missing.map((m) => [m.currency, (values[m.currency] ?? '').trim()] as const);
    if (entries.some(([, v]) => !isPositiveDecimal(v))) {
      setError('Enter a positive rate for each currency, e.g. 1.52.');
      return;
    }
    setError(null);
    const manual = fx.rates.filter((r) => r.source === 'manual').map((r) => `${r.currency}:${r.rate}`);
    onManualRates([...manual, ...entries.map(([c, v]) => `${c}:${v}`)].join(','));
  };
  return (
    <Callout tone="warning" title={`No exchange rate for ${fx.missing.map((m) => m.currency).join(', ')}`}>
      <Stack gap={3}>
        <Text size="sm">
          Totals are shown per currency and percentages are left out, so nothing is silently dropped from a {fx.displayCurrency} total. Enter a rate to convert
          them. It is used for this view only and does not change any records.
        </Text>
        <Form onSubmit={submit} label="Manual exchange rates">
          <Row gap={3} align="start">
            {fx.missing.map((m) => (
              <DecimalField
                key={m.currency}
                label={`${fx.displayCurrency} per 1 ${m.currency}`}
                hint={m.reason}
                value={values[m.currency] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [m.currency]: e.target.value }))}
                error={error ?? undefined}
              />
            ))}
          </Row>
          <Button type="submit" size="sm">
            Use these rates
          </Button>
        </Form>
      </Stack>
    </Callout>
  );
}
