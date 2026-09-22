// @vitest-environment happy-dom
// The visible companion to the session timer stays small: the timer owns the deadline and this component
// only reflects its warning signal as an accessible region with the server-touching action.

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { expiryWarning, resetAppState } from '../app-state.js';
import { ExpiryBanner } from './expiry-banner.js';

beforeEach(resetAppState);

describe('ExpiryBanner', () => {
  it('stays out of the page until the session timer has a warning', () => {
    render(<ExpiryBanner />);
    expect(screen.queryByRole('region', { name: 'Stay signed in' })).toBeNull();
  });

  it('shows the warning text and its stay-signed-in action', () => {
    expiryWarning.value = { minutes: 5 };
    render(<ExpiryBanner />);

    expect(screen.getByRole('region', { name: 'Stay signed in' })).toBeTruthy();
    expect(screen.getByText('You will be signed out in 5 minutes because of inactivity.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBeTruthy();
  });
});
