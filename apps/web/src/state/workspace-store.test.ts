import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const { loadService, mutate, pending, resetWorkspace, rightTab, saveState, service } = await import('./workspace-store.js');

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
