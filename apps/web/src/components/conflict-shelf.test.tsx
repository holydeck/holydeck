// @vitest-environment happy-dom
// The shelf offers keep-mine, keep-theirs and a hand-written combination, and says so when a settlement
// is refused rather than leaving the editor to guess.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';

import { setFetching } from '../request.js';
import { ConflictShelf } from './conflict-shelf.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const shelved = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'shelved',
  contentId: 'song:1',
  sequence: 1,
  attempted: 3,
  origin: 'autosave',
  body: { title: 'Andru' },
  at: '2026-09-17T09:30:00.000Z',
  actor: 'account:7f3a',
  correlationId: 'req-0f9c2a41',
  ...overrides,
});

describe('ConflictShelf', () => {
  it('renders nothing when there are no outstanding conflicts', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({ outstanding: [], entries: [] }, 'req-1')));
    setFetching(fetching);
    const { container } = render(<ConflictShelf contentId="song:1" onResolved={vi.fn()} />);
    await waitFor(() => expect(fetching).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('offers keep-mine and keep-theirs for each outstanding conflict', async () => {
    setFetching(async () => reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1')));
    render(<ConflictShelf contentId="song:1" onResolved={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Keep mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep theirs' })).toBeTruthy();
  });

  it('resolves a conflict with keep-mine, reloads the shelf, and notifies its caller', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ appended: true, revision: 4 }, 'req-2'));
      return reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1'));
    });
    setFetching(fetching);
    const onResolved = vi.fn();
    render(<ConflictShelf contentId="song:1" onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(fetching.mock.calls[1]?.[0]).toBe('/api/v1/content/song%3A1/conflicts/song%3A1%231/resolve');
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ strategy: 'keep-mine' });
  });

  it('resolves a conflict with keep-theirs', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ appended: true, revision: 4 }, 'req-2'));
      return reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1'));
    });
    setFetching(fetching);
    const onResolved = vi.fn();
    render(<ConflictShelf contentId="song:1" onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep theirs' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ strategy: 'keep-theirs' });
  });

  it('combines by sending back the shelved body as the editor amended it', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => {
      if (init.method === 'POST') return reply(200, successEnvelope({ appended: true, revision: 4 }, 'req-2'));
      return reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1'));
    });
    setFetching(fetching);
    const onResolved = vi.fn();
    render(<ConflictShelf contentId="song:1" onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Combine…' }));
    const text = screen.getByLabelText('Combined version (JSON)') as HTMLTextAreaElement;
    expect(JSON.parse(text.value)).toEqual({ title: 'Andru' });
    fireEvent.input(text, { target: { value: '{"title":"Andru, combined"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save combined version' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({
      strategy: 'combine',
      resolvedBody: { title: 'Andru, combined' },
    });
  });

  it('refuses a combination that is not a JSON object before sending anything', async () => {
    const fetching = vi.fn<FetchLike>(async () =>
      reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1')),
    );
    setFetching(fetching);
    render(<ConflictShelf contentId="song:1" onResolved={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Combine…' }));
    fireEvent.input(screen.getByLabelText('Combined version (JSON)'), { target: { value: '[1, 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save combined version' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/must be a JSON object/);
    expect(fetching.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });

  it('says so when a settlement is refused, and keeps the entry on the shelf', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => {
      if (init.method === 'POST') {
        return reply(409, errorEnvelope('entity.conflict', 'Already settled', 'req-2'));
      }
      return reply(200, successEnvelope({ outstanding: [shelved()], entries: [] }, 'req-1'));
    });
    setFetching(fetching);
    const onResolved = vi.fn();
    render(<ConflictShelf contentId="song:1" onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be settled/);
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeTruthy();
  });
});
