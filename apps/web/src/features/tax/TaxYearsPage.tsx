import type { TaxYearList } from '@money/client';
import { Link } from 'react-router';
import { Amount, Badge, ButtonLink, Card, EmptyState, Grid, Loading, Row, Stack, Text } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { useTaxYears } from './data';
import { DISCLAIMER, KIND_LABELS, TaxNav, YearStatusBadge } from './parts';

type YearRow = TaxYearList['years'][number];

function YearCard({ y }: { y: YearRow }) {
  const deductions = y.totals.filter((t) => t.kind === 'DEDUCTION');
  return (
    <Card
      title={
        <Link to={`/tax/years/${y.taxYear}`}>
          FY {y.taxYear}
        </Link>
      }
      actions={
        <Row gap={1}>
          {y.current && <Badge tone="accent">Current year</Badge>}
          <YearStatusBadge status={y.status} />
        </Row>
      }
    >
      <Stack gap={2}>
        <Text size="xs" tone="muted">{y.period.start} to {y.period.end}</Text>
        {y.positionCount === 0 ? (
          <Text size="sm" tone="muted">Nothing recorded yet.</Text>
        ) : (
          <>
            {deductions.map((t) => (
              <Row key={t.currency} justify="between">
                <Text size="sm" as="span">Proposed deductions</Text>
                <Amount value={t.proposed} currency={t.currency} />
              </Row>
            ))}
            {y.totals
              .filter((t) => t.kind !== 'DEDUCTION')
              .map((t) => (
                <Row key={`${t.kind}${t.currency}`} justify="between">
                  <Text size="sm" as="span">Proposed {KIND_LABELS[t.kind]?.toLowerCase()}</Text>
                  <Amount value={t.proposed} currency={t.currency} />
                </Row>
              ))}
            <Text size="sm" tone="muted">
              {y.itemCount} item(s), {y.assetPositionCount} from assets · {y.toReview} to review · {y.withGaps} with open questions
            </Text>
          </>
        )}
        {y.latestFiling && (
          <Text size="xs" tone="muted">
            Filed {y.latestFiling.filedOn} (version {y.latestFiling.version})
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/** The tax section's home: one card per Australian financial year */
export function TaxYearsPage() {
  const years = useTaxYears();
  const header = (
    <>
      <PageHeader
        title="Tax"
        subtitle="Remember things for your tax return during the year, then review them by financial year (1 July to 30 June)."
        actions={
          <>
            <ButtonLink to="/tax/assets/new">Register asset</ButtonLink>
            <ButtonLink to="/tax/items/new" variant="primary">Remember an item</ButtonLink>
          </>
        }
      />
      <TaxNav />
    </>
  );
  if (years.isPending) return <>{header}<Loading label="Loading tax years…" /></>;
  if (years.isError) return <>{header}<ApiErrorCallout error={years.error} title="Could not load your tax years" /></>;
  const list = years.data.years;
  return (
    <>
      {header}
      {list.every((y) => y.positionCount === 0) && (
        <EmptyState title="Nothing remembered yet" action={<ButtonLink to="/tax/items/new" variant="primary">Remember an item</ButtonLink>}>
          Record a work expense, a donation or income to declare as it happens, even before the payment clears. Link the transaction and a receipt URL later.
        </EmptyState>
      )}
      <Grid size="wide">
        {list.map((y) => (
          <YearCard key={y.taxYear} y={y} />
        ))}
      </Grid>
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}
