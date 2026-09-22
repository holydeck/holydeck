import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import type { ServiceView } from './service-data.js';

import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, selection, service } from '../state/workspace-store.js';
import { readPosition, startPositionWriter } from './position-writer.js';

const csrf = 'c'.repeat(43);
const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const view = (id: string): ServiceView => ({
  id, title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: '2026-09-27T10:00:00.000Z',
});

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[], bodies: unknown[]): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    bodies.push(init.body === undefined ? undefined : JSON.parse(init.body));
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  session.value = undefined;
});

describe('the position writer', () => {
  it('sends one PUT carrying the latest position after two changes inside the debounce window', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(fakeFetch({
      'PUT /api/v1/me/workspace-position': reply(200, successEnvelope({ position: { serviceId: 's1', itemId: 'b' } }, 'r1')),
    }, calls, bodies));
    const stop = startPositionWriter();

    service.value = view('s1');
    selection.value = { itemId: 'a' };
    await vi.advanceTimersByTimeAsync(500);
    selection.value = { itemId: 'b' };
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls).toEqual(['PUT /api/v1/me/workspace-position']);
    expect(bodies).toEqual([{ serviceId: 's1', itemId: 'b' }]);
    stop();
  });

  it('sends no PUT for a position identical to the last one it actually sent', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(fakeFetch({
      'PUT /api/v1/me/workspace-position': reply(200, successEnvelope({ position: { serviceId: 's1', itemId: 'a' } }, 'r1')),
    }, calls, bodies));
    const stop = startPositionWriter();

    service.value = view('s1');
    selection.value = { itemId: 'a' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);

    selection.value = { itemId: 'a' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    stop();
  });

  it('cancels a pending write once disposed', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(fakeFetch({}, calls, bodies));
    const stop = startPositionWriter();

    service.value = view('s1');
    selection.value = { itemId: 'a' };
    stop();
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls).toHaveLength(0);
  });

  it('reads the stored position and reports what the server dropped', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const envelope = successEnvelope({ position: { serviceId: 's1', itemId: 'a' } }, 'r1');
    setFetching(fakeFetch({
      'GET /api/v1/me/workspace-position': reply(200, { ...envelope, meta: { ...envelope.meta, dropped: ['slideId'] } }),
    }, calls, bodies));

    const result = await readPosition();

    expect(result).toEqual({ position: { serviceId: 's1', itemId: 'a' }, dropped: ['slideId'] });
  });

  it('answers no position and nothing dropped when nothing is stored yet', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/me/workspace-position': reply(200, successEnvelope({ position: undefined }, 'r1')),
    }, calls, bodies));

    expect(await readPosition()).toEqual({ dropped: [] });
  });

  it('answers no position and nothing dropped when the request fails', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/me/workspace-position': reply(500, errorEnvelope('client.network_unreachable', 'offline', 'r1')),
    }, calls, bodies));

    expect(await readPosition()).toEqual({ dropped: [] });
  });
});
