import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import './button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const classes = (variant: ButtonVariant, size: Size) => ['button', `button--${variant}`, size === 'sm' && 'button--sm'].filter(Boolean).join(' ');

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: Size; children: ReactNode }) {
  return (
    <button type={type} className={classes(variant, size)} {...rest}>
      {children}
    </button>
  );
}

/** A navigation that looks like a button (destinations, not actions) */
export function ButtonLink({ variant = 'secondary', size = 'md', children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: Size }) {
  return (
    <Link className={classes(variant, size)} {...rest}>
      {children}
    </Link>
  );
}
