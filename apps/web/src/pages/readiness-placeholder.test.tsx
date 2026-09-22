// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { expect, it } from 'vitest';

import { ReadinessPlaceholderPage } from './readiness-placeholder.js';

it('renders the readiness placeholder and its service link', () => {
  render(<ReadinessPlaceholderPage id="abc" />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Readiness');
  expect(screen.getByRole('link', { name: 'Back to the service' }).getAttribute('href')).toBe('/services/abc');
});
