import { Amount, Text } from '../../ui';

/**
 * One line per currency. Different currencies are never added together
 * unless the backend returned a converted figure (guidelines §6.5).
 */
export function CurrencyLines({ lines, empty = 'Nothing yet' }: { lines: { currency: string; amount: string }[]; empty?: string }) {
  if (lines.length === 0) {
    return (
      <Text tone="muted" size="sm" as="span">
        {empty}
      </Text>
    );
  }
  return (
    <span className="amount-lines">
      {lines.map((line) => (
        <Amount key={line.currency} value={line.amount} currency={line.currency} />
      ))}
    </span>
  );
}
