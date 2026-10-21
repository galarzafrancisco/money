import type { ReactNode } from 'react';
import { Heading } from './Text';
import './card.css';

/** A surface grouping related content. `flush` removes padding for edge-to-edge tables. */
export function Card({ title, actions, flush = false, children, labelledBy }: { title?: ReactNode; actions?: ReactNode; flush?: boolean; children?: ReactNode; labelledBy?: string }) {
  return (
    <section className={['card', flush && 'card--flush'].filter(Boolean).join(' ')} aria-labelledby={labelledBy}>
      {(title || actions) && (
        <div className="card__header">
          {title && (
            <Heading level={2} size="md" id={labelledBy}>
              {title}
            </Heading>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
