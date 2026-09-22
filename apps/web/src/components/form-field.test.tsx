// @vitest-environment happy-dom
// Form fields carry their help and validation text through an input's accessible description, so this
// small component test guards the relationship separately from any particular form that happens to use it.

import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { FormField } from './form-field.js';

describe('FormField', () => {
  it('connects its label, hint and error to the controlled input', () => {
    const input = vi.fn();
    render(<FormField id="handle" label="Handle" value="ruth" onInput={input} hint="Three to 32 characters." error="Already taken." />);

    const field = screen.getByLabelText('Handle');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe('handle-hint handle-error');
    expect(screen.getByText('Three to 32 characters.').id).toBe('handle-hint');
    expect(screen.getByText('Already taken.').id).toBe('handle-error');

    fireEvent.input(field, { target: { value: 'naomi' } });
    expect(input).toHaveBeenCalledWith('naomi');
  });

  it('does not describe an input with text it did not render', () => {
    render(<FormField id="handle" label="Handle" value="" onInput={() => undefined} />);

    const field = screen.getByLabelText('Handle');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });
});
