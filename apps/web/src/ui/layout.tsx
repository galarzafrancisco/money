import type { ElementType, ReactNode } from 'react';
import './layout.css';

type Gap = 1 | 2 | 3 | 4 | 5 | 6;
type Common = { gap?: Gap; children?: ReactNode; as?: ElementType; className?: string };

/** Vertical layout with consistent spacing */
export function Stack({ gap = 4, as: As = 'div', className, children }: Common) {
  return <As className={['stack', `gap-${gap}`, className].filter(Boolean).join(' ')}>{children}</As>;
}

/** Horizontal layout; wraps on small screens */
export function Row({
  gap = 3,
  justify = 'start',
  align = 'center',
  wrap = true,
  as: As = 'div',
  className,
  children,
}: Common & { justify?: 'start' | 'between' | 'end'; align?: 'center' | 'start'; wrap?: boolean }) {
  const classes = ['row', `gap-${gap}`, justify !== 'start' && `row--${justify}`, align === 'start' && 'row--start', !wrap && 'row--nowrap', className];
  return <As className={classes.filter(Boolean).join(' ')}>{children}</As>;
}

/** Responsive card grid */
export function Grid({ gap = 4, size = 'normal', as: As = 'div', children }: Common & { size?: 'narrow' | 'normal' | 'wide' }) {
  return <As className={['grid', `gap-${gap}`, size !== 'normal' && `grid--${size}`].filter(Boolean).join(' ')}>{children}</As>;
}
