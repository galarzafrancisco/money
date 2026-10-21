import type { ReactNode } from 'react';
import './feedback.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', title, children }: { tone?: BadgeTone; title?: string; children: ReactNode }) {
  return (
    <span className={['badge', tone !== 'neutral' && `badge--${tone}`].filter(Boolean).join(' ')} title={title}>
      {children}
    </span>
  );
}

/** A small colour dot for user-chosen category colours (data, not styling) */
export function Swatch({ color, label }: { color: string | null; label?: string }) {
  return <span className="swatch" style={color ? { background: color } : undefined} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined} />;
}

export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`callout callout--${tone}`} role={tone === 'danger' ? 'alert' : tone === 'success' ? 'status' : undefined}>
      {title && <div className="callout__title">{title}</div>}
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}
