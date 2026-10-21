import type { ElementType, ReactNode } from 'react';
import './text.css';

export type Tone = 'default' | 'muted' | 'danger' | 'success' | 'warning';

export function Heading({ level = 1, size = 'lg', id, children }: { level?: 1 | 2 | 3 | 4; size?: 'lg' | 'md' | 'sm'; id?: string; children: ReactNode }) {
  const Tag = `h${level}` as ElementType;
  return (
    <Tag id={id} className={`heading--${size}`}>
      {children}
    </Tag>
  );
}

export function Text({
  tone = 'default',
  size = 'md',
  mono = false,
  strong = false,
  as: As = 'p',
  children,
}: {
  tone?: Tone;
  size?: 'md' | 'sm' | 'xs';
  mono?: boolean;
  strong?: boolean;
  as?: ElementType;
  children: ReactNode;
}) {
  const classes = [tone !== 'default' && `text--${tone}`, size !== 'md' && `text--${size}`, mono && 'text--mono', strong && 'text--strong'];
  return <As className={classes.filter(Boolean).join(' ') || undefined}>{children}</As>;
}
