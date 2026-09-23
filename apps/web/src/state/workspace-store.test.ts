import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { session } from '../app-state.js';
import { API } from '../api-routes.js';
import { setFetching } from '../request.js';

const storage = new Map<string, string>();
const localStorage = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string): void => { storage.set(key, value); },
  removeItem: (key: string): void => { storage.delete(key); },
  clear: (): void => { storage.clear(); },
  key: (): null => null,
  get length(): number { return storage.size; },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });

const { bulkSelection, isReadOnly, loadService, mutate, pending, resetWorkspace, rightTab, saveState, selection, service } = await import('./workspace-store.js');

const csrf = 'c'.repeat(43);
const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['services.manage']): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions,
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[]): FetchLike => async (url, init) => {
  const key = `${init.method ?? 'GET'} ${url}`;
  calls.push(key);
  const response = map[key];
  if (response === undefined) throw new Error(`No reply for ${key}`);
  return response;
};

const record = (id: string, itemIds: string[]) => ({
  stamp: {
    id, kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:00.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: [{ id: 'sec', name: 'Welcome', items: itemIds.map((itemId) => ({
    id: itemId, kind: 'custom-slide', title: itemId, enabled: true, content: undefined,
  })) }],
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  storage.clear();
  resetWorkspace();
  session.value = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else Object.defineProperty(globalThis, 'localStorage', originalStorage);
});

describe('workspace store', () => {
  it('replaces the service only with the answer, never optimistically', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a', 'b']), 'r1')),
      'POST /api/v1/services/s1/sections/sec/items/reorder': reply(409, errorEnvelope('entity.state_conflict', 'locked', 'r2')),
      'GET /api/v1/services/s1/content-drift': reply(200, successEnvelope([], 'r3')),
    }, calls));
    session.value = signedIn(['services.manage']);
    await loadService('s1');
    const before = service.value;
    const answer = await mutate(API.sectionReorder('s1', 'sec'), { method: 'POST', body: { itemIds: ['b', 'a'] } }, 'a');
    expect(answer.ok).toBe(false);
    expect(service.value).toBe(before);
    expect(pending.value.has('a')).toBe(false);
    expect(saveState.value).toBe('idle');
  });

  it('marks offline on NETWORK_UNREACHABLE and saved on Answered, then refreshes drift', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a']), 'r1')),
      'GET /api/v1/services/s1/content-drift': reply(200, successEnvelope([], 'r2')),
      'POST /offline': reply(500, errorEnvelope('client.network_unreachable', 'offline', 'r3')),
      'POST /saved': reply(200, successEnvelope(record('s1', ['b']), 'r4')),
    }, calls));
    session.value = signedIn();
    await loadService('s1');
    await mutate('/offline', { method: 'POST' });
    expect(saveState.value).toBe('offline');
    await mutate('/saved', { method: 'POST' });
    expect(saveState.value).toBe('saved');
    expect(service.value?.sections[0]?.items[0]?.id).toBe('b');
    expect(calls.filter((call) => call === 'GET /api/v1/services/s1/content-drift')).toHaveLength(2);
  });

  it('leaves read-only on its own once a probe reaches the server again after one failed save', async () => {
    vi.useFakeTimers();
    let reachable = true;
    const calls: string[] = [];
    const answers = fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a']), 'r1')),
      'GET /api/v1/services/s1/content-drift': reply(200, successEnvelope([], 'r2')),
      'POST /save': reply(200, successEnvelope(record('s1', ['a']), 'r3')),
    }, calls);
    setFetching(async (url, init) => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return answers(url, init);
    });
    session.value = signedIn();
    await loadService('s1');

    reachable = false;
    await mutate('/save', { method: 'POST' });
    expect(saveState.value).toBe('offline');
    expect(isReadOnly.value).toBe(true);

    // Still unreachable at the first probe: stays offline and backs off.
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveState.value).toBe('offline');

    reachable = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(saveState.value).toBe('idle');
    expect(isReadOnly.value).toBe(false);
  });

  it('stops probing once the workspace is reset', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setFetching(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      throw new TypeError('Failed to fetch');
    });
    session.value = signedIn();
    service.value = { id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0', sections: [] };
    await mutate('/save', { method: 'POST' });
    resetWorkspace();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['POST /save']);
  });

  it('sends writes one at a time and builds a queued body from the answer before it', async () => {
    const renamed = record('s1', ['a']);
    renamed.sections[0]!.items[0]!.title = 'A2';
    let releasePut: (() => void) | undefined;
    const sent: { key: string; body: unknown }[] = [];
    setFetching(async (url, init) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      if (key === 'GET /api/v1/services/s1') return reply(200, successEnvelope(record('s1', ['a']), 'r1'));
      if (key === 'GET /api/v1/services/s1/content-drift') return reply(200, successEnvelope([], 'r2'));
      sent.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
      if (key === 'PUT /body') {
        await new Promise<void>((resolve) => { releasePut = resolve; });
        return reply(200, successEnvelope(renamed, 'r3'));
      }
      return reply(200, successEnvelope(renamed, 'r4'));
    });
    session.value = signedIn();
    await loadService('s1');

    const put = mutate('/body', { method: 'PUT', body: { title: 'A2' } });
    const patch = mutate('/sections', {
      method: 'PATCH',
      bodyFor: (current) => ({ sections: current.sections.map((section) => section.items.map((item) => item.title)) }),
    });
    await vi.waitFor(() => expect(releasePut).toBeDefined());
    expect(sent.map(({ key }) => key)).toEqual(['PUT /body']);

    releasePut?.();
    await Promise.all([put, patch]);
    expect(sent.map(({ key }) => key)).toEqual(['PUT /body', 'PATCH /sections']);
    expect(sent[1]?.body).toEqual({ sections: [['A2']] });
  });

  it('drops a selected or bulk-selected item once the service no longer has it', () => {
    const item = (id: string) => ({ id, kind: 'custom-slide' as const, title: id, enabled: true, content: undefined });
    const base = { id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming' as const, revision: 'r0' };
    service.value = { ...base, sections: [{ id: 'sec', name: 'Welcome', items: [item('a'), item('b'), item('c')] }] };
    selection.value = { itemId: 'a' };
    bulkSelection.value = new Set(['a', 'b']);

    service.value = { ...base, revision: 'r1', sections: [{ id: 'sec', name: 'Welcome', items: [item('a'), item('b'), item('c')] }] };
    expect(selection.value).toEqual({ itemId: 'a' });

    service.value = { ...base, revision: 'r2', sections: [{ id: 'sec', name: 'Welcome', items: [item('b'), item('c')] }] };
    expect(selection.value).toEqual({});
    expect([...bulkSelection.value]).toEqual(['b']);
  });

  it('persists rightTab to localStorage and survives a throwing storage', async () => {
    rightTab.value = 'library';
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(localStorage.getItem('holydeck.workspace.rightTab')).toBe('library');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { ...localStorage, setItem: (): never => { throw new Error('blocked'); } },
    });
    expect(() => { rightTab.value = 'properties'; }).not.toThrow();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  });
});
