import type { ReactNode } from 'react';
import { decimalSign, formatDecimal } from '../lib/decimal';
import { Swatch } from './Feedback';
import './chart.css';

export type AllocationSegment = {
  key: string;
  label: ReactNode;
  /** Text label for tooltips and screen readers */
  name: string;
  /** Percentage as a decimal string, e.g. "39.47" (from the backend) */
  percent: string;
  /** A user-chosen colour (data, e.g. a category's); otherwise the series slot colour */
  color?: string | null;
};

/** Series colour for the i-th entity, in fixed order; past 8 they share the "other" grey */
export function seriesColor(index: number): string {
  return index < 8 ? `var(--chart-${index + 1})` : 'var(--chart-other)';
}

/**
 * A part-to-whole bar: one segment per share, in the order given, with a
 * legend that names every segment (identity never relies on colour alone).
 * Callers render a table with the same figures next to it.
 */
export function AllocationBar({ segments, label }: { segments: AllocationSegment[]; label: string }) {
  const visible = segments.filter((s) => decimalSign(s.percent) > 0);
  return (
    <figure className="allocation" aria-label={label}>
      <div className="allocation__bar" role="img" aria-label={`${label}: ${visible.map((s) => `${s.name} ${formatDecimal(s.percent, { maxFraction: 2 })}%`).join(', ')}`}>
        {visible.map((s) => (
          <span
            key={s.key}
            className="allocation__segment"
            style={{ width: `${s.percent}%`, background: s.color ?? seriesColor(segments.indexOf(s)) }}
            title={`${s.name}: ${formatDecimal(s.percent, { maxFraction: 2 })}%`}
          />
        ))}
      </div>
      <figcaption className="allocation__legend">
        {segments.map((s, i) => (
          <span key={s.key} className="allocation__item">
            <Swatch color={s.color ?? seriesColor(i)} />
            <span>{s.label}</span>
            <span className="allocation__percent">{formatDecimal(s.percent, { maxFraction: 2 })}%</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * A single-series line over time, for a trend at a glance. Values are plot
 * coordinates only; callers show the exact figures (decimal strings) in text
 * or a table. Hovering a column shows that point's label.
 */
export function TrendLine({ points, label }: { points: { key: string; value: number; title: string }[]; label: string }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 100;
  const height = 40;
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const step = width / (points.length - 1);
  return (
    <svg className="trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="trend__grid" x1="0" x2={width} y1={height - 2} y2={height - 2} vectorEffect="non-scaling-stroke" />
      <polyline className="trend__line" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (
        <rect key={p.key} className="trend__hit" x={Math.max(0, x(i) - step / 2)} y="0" width={step} height={height}>
          <title>{p.title}</title>
        </rect>
      ))}
    </svg>
  );
}
