import type { Holding } from '@money/client';
import { Amount, Badge, Stack, Text } from '../../ui';

/** A price with where it came from; mock and stale prices are always labelled (guidelines §6.5) */
export function PriceProvenance({ price, error }: { price: Holding['price']; error: string | null }) {
  if (!price) {
    return (
      <Text tone="warning" size="sm" as="span">
        {error ?? 'No price'}
      </Text>
    );
  }
  return (
    <Stack gap={1}>
      <Amount value={price.price} currency={price.currency} kind="rate" />
      <span>
        {price.isMock ? (
          <Badge tone="warning" title="Made-up development price, not market data">
            Mock price
          </Badge>
        ) : (
          <Text tone="muted" size="xs" as="span">
            {price.source} · {price.asOf.slice(0, 10)}
          </Text>
        )}
      </span>
      {price.isStale && (
        <span>
          <Badge tone="warning" title="The price provider could not be reached; this is the last price Money has">
            Last known price
          </Badge>
        </span>
      )}
      {error && (
        <Text tone="warning" size="xs" as="span">
          {error}
        </Text>
      )}
    </Stack>
  );
}
