// @vitest-environment happy-dom
// A presence entry that fails to parse is dropped rather than rendered as a broken chip: this component
// trusts the poll no more than any other network answer does. The session's own entry is never shown.

import { render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';

import type { SessionView } from '@holydeck/contracts/sessions';

import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { MAX_CHIPS, POLL_MS, PresenceIndicator } from './presence-indicator.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentId: 'song:1',
  actor: 'account:1',
  enteredAt: '2026-09-22T00:00:00.000Z',
  heartbeatAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:05:00.000Z',
  ...overrides,
});

const others = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) => entry({ actor: `account:${index + 2}`, displayName: `Editor ${index + 2}` }));

afterEach(() => {
  session.value = undefined;
  vi.useRealTimers();
});

describe('PresenceIndicator', () => {
  it('says who is also editing, by the name their account gives them', async () => {
    setFetching(async () => reply(200, successEnvelope([entry({ displayName: 'Chioma Obi' })], 'req-1')));
    render(<PresenceIndicator contentId="song:1" />);
    expect(await screen.findByText('Also editing')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Chioma Obi is editing' }).textContent).toBe('CO');
  });

  it('leaves the session itself out of the row', async () => {
    session.value = { actor: 'account:1' } as unknown as SessionView;
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([entry()], 'req-1')));
    setFetching(fetching);
    const { container } = render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(2));
    expect(container.querySelector('.presence-indicator')).toBeNull();
  });

  it(`shows ${MAX_CHIPS} editors at most and counts the rest`, async () => {
    setFetching(async () => reply(200, successEnvelope(others(MAX_CHIPS + 2), 'req-1')));
    render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(screen.getAllByRole('img', { name: /editing/i })).toHaveLength(MAX_CHIPS));
    expect(screen.getByText('+2 more')).toBeTruthy();
  });

  it('renews the lease every fifteen seconds', async () => {
    vi.useFakeTimers();
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([], 'req-1')));
    setFetching(fetching);
    render(<PresenceIndicator contentId="song:1" />);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(fetching.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetching.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
    expect(POLL_MS).toBe(15_000);
  });

  it('leaves the presence lease when the page is hidden for good', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([], 'req-1')));
    setFetching(fetching);
    render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(fetching).toHaveBeenCalled());
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(fetching.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true));
  });

  it('renders one chip per active editor', async () => {
    setFetching(async () => reply(200, successEnvelope([entry()], 'req-1')));
    render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(screen.getAllByRole('img', { name: /editing/i })).toHaveLength(1));
  });

  it('renders nothing when nobody else is editing', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([], 'req-1')));
    setFetching(fetching);
    const { container } = render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(fetching).toHaveBeenCalled());
    expect(container.querySelector('.presence-indicator')).toBeNull();
  });

  it('drops an entry that fails to parse rather than rendering it', async () => {
    setFetching(async () => reply(200, successEnvelope([entry(), { contentId: 'song:1' }], 'req-1')));
    render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(screen.getAllByRole('img', { name: /editing/i })).toHaveLength(1));
  });

  it('leaves the presence lease on unmount', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([], 'req-1')));
    setFetching(fetching);
    const { unmount } = render(<PresenceIndicator contentId="song:1" />);
    await waitFor(() => expect(fetching).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(fetching.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true));
  });
});
