// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onboardingOffer } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import { SESSION_PATH } from '@holydeck/contracts/sessions';

import type { FetchLike } from './api.js';

import { App } from './app.js';
import { onboarding, resetAppState, session } from './app-state.js';
import { setFetching } from './request.js';
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
    setFetching(async () => ({
      status: 500,
      json: async (): Promise<unknown> => ({ error: { code: 'test.refused', message: 'Refused', requestId: 'test' } }),
    }));
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
  ])('renders %s inside the shell', async (path, heading) => {
    session.value = signedIn;
    at(path);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it.each([
    ['/welcome', 'Welcome to HolyDeck'],
    ['/sign-in', 'Sign in'],
  ])('renders %s in the signed-out frame', (path, heading) => {
    session.value = null;
    onboarding.value = path === '/welcome' ? onboardingOffer() : 'claimed';
    at(path);
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('ends the session when the shell sign-out button is clicked', () => {
    const fetching = vi.fn<FetchLike>(async () => ({
      status: 200,
      json: async (): Promise<unknown> => successEnvelope({}, 'request-1'),
    }));
    setFetching(fetching);
    session.value = signedIn;
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(fetching).toHaveBeenCalledWith(SESSION_PATH, expect.objectContaining({ method: 'DELETE' }));
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
