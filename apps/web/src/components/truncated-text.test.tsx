// @vitest-environment happy-dom
// Truncation is only a visual convenience: the complete text remains in the document, and an ordinary
// visible button — not a hover affordance — lets keyboard, touch and pointer users disclose it in place.

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { locale, resetAppState } from '../app-state.js';
import { TruncatedText } from './truncated-text.js';

beforeEach(resetAppState);

describe('TruncatedText', () => {
  it('keeps its disclosure button visible without hover', () => {
    render(<TruncatedText text="A complete service title that does not fit" />);

    const button = screen.getByRole('button', { name: 'Show full text' });
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the full text and updates the expanded state when toggled', () => {
    render(<TruncatedText text="A complete service title that does not fit" />);
    const text = screen.getByText('A complete service title that does not fit');
    const button = screen.getByRole('button', { name: 'Show full text' });

    expect(text.classList.contains('truncated-text-content-expanded')).toBe(false);
    fireEvent.click(button);
    expect(text.classList.contains('truncated-text-content-expanded')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toBe('Show less');
  });

  it('localizes the visible disclosure action', () => {
    act(() => {
      locale.value = 'de';
    });
    render(<TruncatedText text="Langer Titel" />);
    expect(screen.getByRole('button', { name: 'Vollständigen Text anzeigen' })).toBeTruthy();
  });
});
