// @vitest-environment happy-dom
// The bell every signed-in account carries (OUI-04): its own unread count, and the panel behind it.
// `?unread=true` is also the panel's own content — there is no separate count field — so most of these
// tests read the badge and the list off the same mocked feed a real poll would return.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';

import { setFetching } from '../request.js';
import { NotificationBell, POLL_MS } from './notification-bell.js';

import type { FetchLike } from '../api.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: 'n1',
  accountId: 'a1',
  event: 'content.change',
  channel: 'inApp',
  category: 'content',
  action: 'song.create',
  subject: 'song:1',
  outcome: 'allowed',
  severity: 'notice',
  correlationId: 'c1',
  createdAt: '2026-09-24T10:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
});

describe('NotificationBell', () => {
  it('shows how many notifications are unread, from the unread feed', async () => {
    const fetching = vi.fn<FetchLike>(async () =>
      reply(200, successEnvelope({ notifications: [row({ _id: 'n1' }), row({ _id: 'n2' })] }, 'r1')));
    setFetching(fetching);
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelector('.notification-bell-badge')?.textContent).toBe('2'));
    expect(fetching.mock.calls[0]?.[0]).toBe('/api/v1/notifications?unread=true');
  });

  it('shows no badge and disables mark-all-read when nothing is unread', async () => {
    setFetching(async () => reply(200, successEnvelope({ notifications: [] }, 'r1')));
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(screen.getByText('No notifications.')).toBeTruthy());
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
    expect((screen.getByRole('button', { name: 'Mark all as read' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops a notification row that fails to parse rather than rendering it', async () => {
    setFetching(async () =>
      reply(200, successEnvelope({ notifications: [row({ _id: 'n1' }), { _id: 'n2' }] }, 'r1')));
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(1));
  });

  it('polls its unread feed every thirty seconds', async () => {
    vi.useFakeTimers();
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({ notifications: [] }, 'r1')));
    setFetching(fetching);
    render(<NotificationBell />);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(fetching).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetching).toHaveBeenCalledTimes(2);
    expect(POLL_MS).toBe(30_000);
  });

  it('pauses polling while the tab is hidden, and resumes it once shown again', async () => {
    vi.useFakeTimers();
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({ notifications: [] }, 'r1')));
    setFetching(fetching);
    render(<NotificationBell />);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetching).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetching).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetching).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetching).toHaveBeenCalledTimes(3);
  });

  it('opens the panel on click and links each item to what it is about', async () => {
    setFetching(async () =>
      reply(200, successEnvelope({
        notifications: [
          row({ _id: 'n1', category: 'content', subject: 'song:1' }),
          row({ _id: 'n2', category: 'presentation', subject: 'run:1' }),
          row({ _id: 'n3', category: 'settings', subject: 'actor:a9' }),
        ],
      }, 'r1')));
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(3));

    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(container.querySelector('summary') as HTMLElement);
    expect(details.open).toBe(true);

    const links = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual(['/content/song%3A1/history', '/services', '/admin/settings']);
  });

  it('falls back to the audit log for a category it does not recognise', async () => {
    setFetching(async () =>
      reply(200, successEnvelope({ notifications: [row({ _id: 'n1', category: 'mystery', subject: 'x' })] }, 'r1')));
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(1));
    expect(screen.getByRole('link').getAttribute('href')).toBe('/admin/audit');
    expect(screen.getByText('mystery')).toBeTruthy();
  });

  it('marks one notification read through its own route, and removes it from the panel', async () => {
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ read: true }, 'r-read'));
      return reply(200, successEnvelope({ notifications: [row({ _id: 'n1' })] }, 'r-list'));
    });
    setFetching(fetching);
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(0));
    expect(fetching).toHaveBeenCalledWith('/api/v1/notifications/n1/read', expect.objectContaining({ method: 'POST' }));
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
  });

  it('marks every unread notification read through the read-all route, and clears the badge', async () => {
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ read: true }, 'r-read-all'));
      return reply(200, successEnvelope({ notifications: [row({ _id: 'n1' }), row({ _id: 'n2' })] }, 'r-list'));
    });
    setFetching(fetching);
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(0));
    expect(fetching).toHaveBeenCalledWith('/api/v1/notifications/read-all', expect.objectContaining({ method: 'POST' }));
    expect(container.querySelector('.notification-bell-badge')).toBeNull();
  });

  it('dismisses one notification through its own route, and removes it from the panel', async () => {
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ dismissed: true }, 'r-dismiss'));
      return reply(200, successEnvelope({ notifications: [row({ _id: 'n1' })] }, 'r-list'));
    });
    setFetching(fetching);
    const { container } = render(<NotificationBell />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(0));
    expect(fetching).toHaveBeenCalledWith('/api/v1/notifications/n1/dismiss', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps a dismissed notification out of the badge once the next poll confirms the server dropped it', async () => {
    vi.useFakeTimers();
    let dismissed = false;
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'POST') {
        dismissed = true;
        return reply(200, successEnvelope({ dismissed: true }, 'r-dismiss'));
      }
      return reply(200, successEnvelope({ notifications: dismissed ? [] : [row({ _id: 'n1' })] }, 'r-list'));
    });
    setFetching(fetching);
    const { container } = render(<NotificationBell />);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll('li')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll('li')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('announces a new arrival through the shared polite region while the panel is closed', async () => {
    vi.useFakeTimers();
    let call = 0;
    const responses = [
      { notifications: [row({ _id: 'n1' })] },
      { notifications: [row({ _id: 'n1' }), row({ _id: 'n2' })] },
    ];
    const fetching = vi.fn<FetchLike>(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return reply(200, successEnvelope(body, `r${call}`));
    });
    setFetching(fetching);
    document.body.innerHTML = '<p id="announce-polite" aria-live="polite"></p>';
    render(<NotificationBell />);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('announce-polite')?.textContent).toBe('');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(document.getElementById('announce-polite')?.textContent).toBe('1 new notification');
  });

  it('stays quiet in the live region while the panel is open', async () => {
    vi.useFakeTimers();
    let call = 0;
    const responses = [
      { notifications: [row({ _id: 'n1' })] },
      { notifications: [row({ _id: 'n1' }), row({ _id: 'n2' })] },
    ];
    const fetching = vi.fn<FetchLike>(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return reply(200, successEnvelope(body, `r${call}`));
    });
    setFetching(fetching);
    document.body.innerHTML = '<p id="announce-polite" aria-live="polite"></p>';
    const { container } = render(<NotificationBell />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(container.querySelector('summary') as HTMLElement);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(document.getElementById('announce-polite')?.textContent).toBe('');
  });
});
