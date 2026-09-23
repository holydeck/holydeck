// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { mutate, resetWorkspace, service } from '../state/workspace-store.js';
import { runOrderSteps } from './order-actions.js';
import { reorderPlan } from './order-ops.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const signedIn = (): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const record = (titleOfA: string) => ({
  stamp: {
    id: 's1', kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:01.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: [
    { id: 'one', name: 'Welcome', items: [{ id: 'a', kind: 'custom-slide', title: titleOfA, enabled: true, content: undefined }] },
    { id: 'two', name: 'Response', items: [] },
  ],
});

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [
    { id: 'one', name: 'Welcome', items: [{ id: 'a', kind: 'custom-slide', title: 'a', enabled: true, content: undefined }] },
    { id: 'two', name: 'Response', items: [] },
  ],
};

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  service.value = view;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runOrderSteps', () => {
  it('builds a cross-section move from the item as an earlier, still-running save left it', async () => {
    let release: (() => void) | undefined;
    const patches: unknown[] = [];
    setFetching(async (url, init) => {
      if (url === '/api/v1/services/s1/content-drift') return reply(200, successEnvelope([], 'r-drift'));
      if (init.method === 'PUT') {
        await new Promise<void>((resolve) => { release = resolve; });
        return reply(200, successEnvelope(record('edited'), 'r1'));
      }
      if (init.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string));
        return reply(200, successEnvelope(record('edited'), 'r2'));
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    });

    const save = mutate('/api/v1/services/s1/items/a/body', { method: 'PUT', body: {} });
    const move = runOrderSteps('s1', 'a', reorderPlan(view, 'a', { sectionId: 'two', index: 0 }));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(patches).toHaveLength(0);
    release?.();
    await Promise.all([save, move]);

    expect(patches).toHaveLength(1);
    const sections = (patches[0] as { sections: { id: string; items: { title: string }[] }[] }).sections;
    expect(sections.find((section) => section.id === 'one')?.items).toEqual([]);
    expect(sections.find((section) => section.id === 'two')?.items[0]?.title).toBe('edited');
  });
});
