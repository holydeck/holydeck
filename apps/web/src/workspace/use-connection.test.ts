// @vitest-environment happy-dom

import { renderHook } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';

import { setFetching } from '../request.js';
import { resetWorkspace, saveState } from '../state/workspace-store.js';
import { useConnection } from './use-connection.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const record = (id: string) => ({
  stamp: {
    id, kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:00.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
});

const fakeFetch = (calls: string[]): FetchLike => async (url, init) => {
  calls.push(`${init.method ?? 'GET'} ${url}`);
  if (url.endsWith('/content-drift')) return reply(200, successEnvelope([], 'r-drift'));
  return reply(200, successEnvelope(record('s1'), 'r-service'));
};

beforeEach(() => {
  resetWorkspace();
});

describe('useConnection', () => {
  it('freezes editing offline and reloads the service once back online', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch(calls));
    renderHook(() => useConnection('s1'));

    globalThis.dispatchEvent(new Event('offline'));
    expect(saveState.value).toBe('offline');

    globalThis.dispatchEvent(new Event('online'));
    expect(saveState.value).toBe('checking');

    await vi.waitFor(() => expect(saveState.value).toBe('idle'));
    expect(calls).toContain('GET /api/v1/services/s1');
  });

  it('stays offline if a fresh offline event lands mid-reconnect', async () => {
    const calls: string[] = [];
    let resolveService: (() => void) | undefined;
    const fetching: FetchLike = async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.endsWith('/content-drift')) return reply(200, successEnvelope([], 'r-drift'));
      await new Promise<void>((resolve) => { resolveService = resolve; });
      return reply(200, successEnvelope(record('s1'), 'r-service'));
    };
    setFetching(fetching);
    renderHook(() => useConnection('s1'));

    globalThis.dispatchEvent(new Event('online'));
    expect(saveState.value).toBe('checking');

    globalThis.dispatchEvent(new Event('offline'));
    expect(saveState.value).toBe('offline');

    resolveService?.();
    await vi.waitFor(() => expect(calls).toContain('GET /api/v1/services/s1'));
    expect(saveState.value).toBe('offline');
  });

  it('goes back offline, not idle, when the reconnect check fails', async () => {
    const calls: string[] = [];
    const fetching: FetchLike = async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return reply(500, errorEnvelope('client.network_unreachable', 'still down', 'r-err'));
    };
    setFetching(fetching);
    renderHook(() => useConnection('s1'));

    globalThis.dispatchEvent(new Event('online'));
    expect(saveState.value).toBe('checking');

    await vi.waitFor(() => expect(saveState.value).toBe('offline'));
    expect(calls).toContain('GET /api/v1/services/s1');
  });

  it('stops listening once unmounted', () => {
    const calls: string[] = [];
    setFetching(fakeFetch(calls));
    const { unmount } = renderHook(() => useConnection('s1'));
    unmount();

    globalThis.dispatchEvent(new Event('offline'));
    expect(saveState.value).toBe('idle');
  });
});
