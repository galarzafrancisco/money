import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import './nav.css';

export type TabItem = { to: string; label: ReactNode; end?: boolean };

/** Section navigation rendered as tabs; each tab is a URL (deep-linkable) */
export function TabNav({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <nav className="tabnav" aria-label={label}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className="tabnav__link">
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** A radio group styled as buttons */
export function SegmentedControl<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: ReactNode;
  name: string;
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="segmented__legend">{legend}</legend>
      {options.map((option) => (
        <span className="segmented__option" key={option.value}>
          <input
            type="radio"
            id={`${name}-${option.value}`}
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <label className="segmented__label" htmlFor={`${name}-${option.value}`}>
            {option.label}
          </label>
        </span>
      ))}
    </fieldset>
  );
}

/** Wizard progress */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((step, i) => (
        <li key={step} className={['steps__item', i < current && 'steps__item--done'].filter(Boolean).join(' ')} aria-current={i === current ? 'step' : undefined}>
          <span className="steps__number" aria-hidden>
            {i < current ? '✓' : i + 1}
          </span>
          <span>
            {step}
            {i < current && <span className="visually-hidden"> (done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
