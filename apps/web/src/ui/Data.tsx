import type { ReactNode } from 'react';
import { decimalSign, formatCompactDecimal, formatDecimal } from '../lib/decimal';
import './data.css';

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  /** Keep on one line (dates, codes) */
  nowrap?: boolean;
};

/** A data table that scrolls horizontally on small screens */
export function Table<T>({ columns, rows, rowKey, caption, footer, label }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; caption?: ReactNode; footer?: ReactNode; label?: string }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={label ? 0 : undefined}>
      <table className="table">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={[c.numeric && 'num', c.nowrap && 'nowrap'].filter(Boolean).join(' ') || undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

/**
 * A decimal string with its currency, formatted without floating point.
 * `signed` colours gains and losses. A null value renders as an em dash.
 */
export function Amount({ value, currency, signed = false, kind = 'money' }: { value: string | null | undefined; currency?: string | null; signed?: boolean; kind?: 'money' | 'quantity' | 'rate' | 'percent' }) {
  if (value === null || value === undefined) return <span className="amount">—</span>;
  // Max 2 decimals everywhere. Quantities and rates that would round to zero
  // (e.g. 0.00012 BTC) keep more places so they don't read as nothing.
  const capped = (max: number) => {
    const text = formatDecimal(value, { maxFraction: max });
    return decimalSign(value) !== 0 && decimalSign(text.replace(/,/g, '')) === 0 ? formatDecimal(value, { maxFraction: 8 }) : text;
  };
  const formatted = kind === 'money' ? formatCompactDecimal(value) : kind === 'percent' ? `${formatDecimal(value, { maxFraction: 2 })}%` : capped(2);
  const sign = signed ? decimalSign(value) : 0;
  const classes = ['amount', sign > 0 && 'amount--positive', sign < 0 && 'amount--negative'];
  return (
    <span className={classes.filter(Boolean).join(' ')}>
      {signed && sign > 0 ? '+' : ''}
      {formatted}
      {currency && <span className="amount__currency">{currency}</span>}
    </span>
  );
}

export function DescriptionList({ items }: { items: { term: ReactNode; detail: ReactNode; key?: string }[] }) {
  return (
    <dl className="dl">
      {items.map((item, i) => (
        <div key={item.key ?? i} className="dl__item">
          <dt>{item.term}</dt>
          <dd>{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
