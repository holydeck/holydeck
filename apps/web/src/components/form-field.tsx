// The forms in the signed-out client all need the same small accessible unit: one explicit label, one
// controlled input, and any help or validation message it describes. Keeping that wiring here makes a
// new form start with the relationship a screen reader needs instead of relying on each page to repeat it.

import type { JSX } from 'preact';

/** The labelled, controlled text input every application form shares. */
export function FormField(props: {
  readonly id: string;
  readonly label: string;
  readonly type?: 'text' | 'password';
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly inputMode?: 'numeric' | 'text';
}): JSX.Element {
  const describedBy = [props.hint === undefined ? undefined : `${props.id}-hint`, props.error === undefined ? undefined : `${props.id}-error`]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  return (
    <div class="form-field">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        aria-invalid={props.error === undefined ? undefined : 'true'}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        maxLength={props.maxLength}
        inputMode={props.inputMode}
      />
      {props.hint === undefined ? null : <p id={`${props.id}-hint`} class="form-hint">{props.hint}</p>}
      {props.error === undefined ? null : <p id={`${props.id}-error`} class="form-error">{props.error}</p>}
    </div>
  );
}
