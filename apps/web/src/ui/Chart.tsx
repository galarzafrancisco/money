import { useState, type PointerEvent, type ReactNode } from 'react';
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

export type TrendPoint = { key: string; value: number; title: string; date: string };

const W = 640;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(t);
  return ticks;
}

function compactMoney(v: number): string {
  return `$${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}`;
}

function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

/**
 * A single-series line over time with light $ and date axes. Hover (desktop)
 * or touch and drag (mobile) shows a guide line with the date and value.
 * Values are plot coordinates only; callers show exact figures in text.
 */
export function TrendLine({ points, label }: { points: TrendPoint[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yTicks = niceTicks(min, max, 4);
  const lo = Math.min(min, yTicks[0] ?? min);
  const hi = Math.max(max, yTicks[yTicks.length - 1] ?? max);
  const span = hi - lo || 1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * iw;
  const y = (v: number) => PAD.top + ih - ((v - lo) / span) * ih;
  const xTickIdx = [0, 1, 2, 3].map((k) => Math.round((k / 3) * (points.length - 1)));

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / iw) * (points.length - 1));
    setActive(Math.max(0, Math.min(points.length - 1, i)));
  };
  const a = active === null ? null : points[active];
  const anchorRight = active !== null && active > points.length * 0.6;
  return (
    <svg
      className="trend"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      onPointerDown={pick}
      onPointerMove={pick}
      onPointerLeave={() => setActive(null)}
      onPointerCancel={() => setActive(null)}
    >
      {yTicks.map((t) => (
        <g key={t}>
          <line className="trend__grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="trend__tick" x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {compactMoney(t)}
          </text>
        </g>
      ))}
      {xTickIdx.map((i, k) => (
        <text key={i} className="trend__tick" x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'}>
          {shortDate(points[i].date)}
        </text>
      ))}
      <polyline className="trend__line" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
      {a && active !== null && (
        <g className="trend__cursor" pointerEvents="none">
          <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + ih} />
          <circle cx={x(active)} cy={y(a.value)} r="4" />
          <text className="trend__readout" x={x(active) + (anchorRight ? -8 : 8)} y={PAD.top + 12} textAnchor={anchorRight ? 'end' : 'start'}>
            {a.title}
          </text>
        </g>
      )}
    </svg>
  );
}
