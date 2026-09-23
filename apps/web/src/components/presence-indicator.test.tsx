// @vitest-environment happy-dom
// A presence entry that fails to parse is dropped rather than rendered as a broken chip: this component
// trusts the poll no more than any other network answer does.

import { render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';

import { setFetching } from '../request.js';
import { PresenceIndicator } from './presence-indicator.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentId: 'song:1',
  actor: 'account:1',
  enteredAt: '2026-09-22T00:00:00.000Z',
  heartbeatAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:05:00.000Z',
  ...overrides,
});

describe('PresenceIndicator', () => {
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
