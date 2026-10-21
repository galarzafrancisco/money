import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import './form.css';

type FieldProps = { label: ReactNode; hint?: ReactNode; error?: string | null; badge?: ReactNode };

function FieldFrame({ id, label, hint, error, badge, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {badge && <span className="field__badge">{badge}</span>}
      </label>
      {children}
      {hint && (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field__error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
}

export function TextField({ label, hint, error, badge, mono, ...input }: FieldProps & { mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} badge={badge}>
      <input id={id} className={['control', mono && 'control--mono'].filter(Boolean).join(' ')} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...input} />
    </FieldFrame>
  );
}

/** A decimal amount typed as text: never parsed into a JavaScript number */
export function DecimalField(props: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <TextField inputMode="decimal" autoComplete="off" mono {...props} />;
}

export function SelectField({ label, hint, error, badge, children, ...select }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} badge={badge}>
      <select id={id} className="control" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...select}>
        {children}
      </select>
    </FieldFrame>
  );
}

export function TextAreaField({ label, hint, error, badge, ...textarea }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} badge={badge}>
      <textarea id={id} className="control" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...textarea} />
    </FieldFrame>
  );
}

export function Checkbox({ label, ...input }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...input} />
      <span>{label}</span>
    </label>
  );
}

export function Fieldset({ legend, children }: { legend: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="fieldset">
      <legend className="fieldset__legend">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** A form constrained to a readable width */
export function Form({ onSubmit, children, label }: { onSubmit: () => void; children: ReactNode; label?: string }) {
  return (
    <form
      className="form"
      aria-label={label}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
