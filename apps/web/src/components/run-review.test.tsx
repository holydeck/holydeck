// @vitest-environment happy-dom
// OUI-05: the run review and recap section mounted on a service's live page. These tests keep its two
// gates independent (review needs `presentation.control`; recap needs that or `service.read`) and keep
// "the latest ended run" honest against a server that never promises its list is already sorted.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import { locale, resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { RunReview } from './run-review.js';

import type { FetchLike } from '../api.js';

/** Matches `run-review.tsx`'s own formatting, so this test stays honest across the runner's timezone. */
const dateTimeOf = (at: string): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const textReply = (status: number, body: unknown, text?: string) => ({
  status,
  json: async (): Promise<unknown> => body,
  text: async (): Promise<string> => text ?? '',
});

const signedIn = (permissions: readonly string[]): SessionView => ({
  account: { id: 'a1', name: 'andru', displayName: 'Andru Example', role: 'admin', controlPresentation: false },
  actor: 'account:a1',
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'c'.repeat(43),
  slots: [],
} as unknown as SessionView);

const run = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  serviceId: 'sunday',
  snapshotId: 'snap-1',
  phase: 'ended',
  mode: 'live',
  live: {},
  stateRevision: 1,
  startedAt: '2026-09-20T09:00:00.000Z',
  endedAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

const reference = (overrides: Record<string, unknown> = {}) => ({
  sequence: 1,
  at: '2026-09-20T09:05:00.000Z',
  actor: 'account:a1',
  itemId: 'item-1',
  reference: 'John 3:16 (KJV)',
  ...overrides,
});

describe('RunReview', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for a session holding neither presentation.control nor service.read', async () => {
    session.value = signedIn([]);
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    const { container } = render(<RunReview serviceId="sunday" />);
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
    expect(fetching).not.toHaveBeenCalled();
  });

  it('renders nothing when the service has no ended run yet', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async () => reply(200, successEnvelope([], 'r1')));
    const { container } = render(<RunReview serviceId="sunday" />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('picks the latest ended run by endedAt, not by list order', async () => {
    session.value = signedIn(['presentation.control']);
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path.startsWith('/api/v1/runs?')) {
        return reply(200, successEnvelope([
          run({ runId: 'run-old', endedAt: '2026-09-19T10:00:00.000Z' }),
          run({ runId: 'run-new', endedAt: '2026-09-21T10:00:00.000Z' }),
        ], 'r1'));
      }
      if (path === '/api/v1/runs/run-new/review') return reply(200, successEnvelope([reference()], 'r2'));
      throw new Error(`unexpected request: ${path}`);
    });
    setFetching(fetching);
    render(<RunReview serviceId="sunday" />);
    await screen.findByText(`John 3:16 (KJV) — shown by account:a1 at ${dateTimeOf('2026-09-20T09:05:00.000Z')}`);
  });

  it('shows the review list for presentation.control, oldest first as the server answers it', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') {
        return reply(200, successEnvelope([reference({ sequence: 1, reference: 'First' }), reference({ sequence: 2, reference: 'Second' })], 'r2'));
      }
      return reply(200, successEnvelope('1. First', 'r3'));
    });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('What was shown');
    const items = await screen.findAllByRole('listitem');
    const at = dateTimeOf('2026-09-20T09:05:00.000Z');
    expect(items.map((item) => item.textContent)).toEqual([
      `First — shown by account:a1 at ${at}`,
      `Second — shown by account:a1 at ${at}`,
    ]);
  });

  it('shows an empty message when the run showed nothing', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      return textReply(200, {}, '');
    });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('This run has not shown anything yet.');
  });

  it('reports a refused review without hiding the recap section', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(403, errorEnvelope('forbidden', 'no', 'r2'));
      return textReply(200, {}, '1. First');
    });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('The review could not be loaded.');
    await screen.findByText('Recap');
  });

  it('hides the review section but shows the recap for a session holding only service.read', async () => {
    session.value = signedIn(['service.read']);
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path.startsWith('/api/v1/runs/run-1/recap')) return textReply(200, {}, '1. First');
      throw new Error(`unexpected request: ${path}`);
    });
    setFetching(fetching);
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('Recap');
    expect(screen.queryByText('What was shown')).toBeNull();
    expect(fetching.mock.calls.some(([path]) => String(path).includes('/review'))).toBe(false);
  });

  it('fetches a markdown recap by default and switches to text on request', async () => {
    session.value = signedIn(['presentation.control']);
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      if (path === '/api/v1/runs/run-1/recap?format=md') return textReply(200, {}, '1. First');
      if (path === '/api/v1/runs/run-1/recap?format=text') return textReply(200, {}, 'First');
      throw new Error(`unexpected request: ${path}`);
    });
    setFetching(fetching);
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('1. First');
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'text' } });
    await screen.findByText('First');
  });

  it('marks a rehearsal run and lets the operator opt it into the recap', async () => {
    session.value = signedIn(['presentation.control']);
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run({ mode: 'rehearsal' })], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      if (path === '/api/v1/runs/run-1/recap?format=md') return textReply(200, {}, '');
      if (path === '/api/v1/runs/run-1/recap?format=md&includeRehearsal=true') return textReply(200, {}, '1. Practised');
      throw new Error(`unexpected request: ${path}`);
    });
    setFetching(fetching);
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('This was a rehearsal run.');
    await screen.findByText('This run has no recap to show.');
    fireEvent.click(screen.getByLabelText('Include this rehearsal in the recap'));
    await screen.findByText('1. Practised');
  });

  it('copies the recap to the clipboard', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      return textReply(200, {}, '1. First');
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('1. First');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1. First'));
    await screen.findByText('Copied to the clipboard.');
  });

  it('reports a clipboard write that refused', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      return textReply(200, {}, '1. First');
    });
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('1. First');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByText('The recap could not be copied.');
  });

  it('downloads the recap as a file named for its run and format', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async (path) => {
      if (path.startsWith('/api/v1/runs?')) return reply(200, successEnvelope([run()], 'r1'));
      if (path === '/api/v1/runs/run-1/review') return reply(200, successEnvelope([], 'r2'));
      return textReply(200, {}, '1. First');
    });
    const kept: Blob[] = [];
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = vi.fn((blob: Blob) => {
        kept.push(blob);
        return 'blob:recap';
      });
      static override revokeObjectURL = vi.fn();
    });
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('1. First');
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    HTMLAnchorElement.prototype.click = originalClick;
    expect(clicked).toEqual(['run-run-1-recap.md']);
    expect(kept).toHaveLength(1);
  });

  it('reports a run list that could not be loaded', async () => {
    session.value = signedIn(['presentation.control']);
    setFetching(async () => reply(403, errorEnvelope('forbidden', 'no', 'r1')));
    render(<RunReview serviceId="sunday" />);
    await screen.findByText('The list of ended runs could not be loaded.');
  });
});
