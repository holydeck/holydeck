// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from './app.js';
import { resetAppState, session } from './app-state.js';
import { currentPath } from './router.js';

import type { SessionView } from '@holydeck/contracts/sessions';

const signedIn = { csrf: 'c'.repeat(43), permissions: [], slots: [] } as unknown as SessionView;

const at = (path: string): void => {
  currentPath.value = path;
};

describe('the route to page switch', () => {
  beforeEach(() => {
    resetAppState();
    at('/services');
  });

  it('shows only the loading line until boot has answered', () => {
    render(<App />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it.each([
    ['/services', 'Services'],
    ['/services/s1', 'Service s1'],
    ['/admin/users', 'Users'],
    ['/nowhere', 'Page not found'],
  ])('renders %s inside the shell', (path, heading) => {
    session.value = signedIn;
    at(path);
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
    expect(screen.getByRole('navigation')).toBeTruthy();
  });

  it.each([
    ['/welcome', 'Welcome'],
    ['/sign-in', 'Sign in'],
  ])('renders %s in the signed-out frame', (path, heading) => {
    session.value = null;
    at(path);
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(heading);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('waits on the root path for boot to move on', () => {
    session.value = null;
    at('/');
    render(<App />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });

  it('renders an output window on its own, from its own chunk', async () => {
    session.value = null;
    at('/output/audience');
    const { container } = render(<App />);
    expect(screen.queryByRole('main')).toBeNull();
    await screen.findByText((_, element) => element?.getAttribute('data-output-kind') === 'audience');
    expect(container.querySelector('.output-surface')).not.toBeNull();
  });
});
