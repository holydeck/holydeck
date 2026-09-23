// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../../api.js';
import { session } from '../../app-state.js';
import { setFetching } from '../../request.js';
import { resetWorkspace, selection, service } from '../../state/workspace-store.js';
import type { ServiceView } from '../service-data.js';
import { BlankSlideTab } from './BlankSlideTab.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const item = (id: string): ServiceItem => ({ id, kind: 'custom-slide', title: `Item ${id}`, enabled: true, content: undefined });
const viewWith = (ids: string[], state: ServiceView['state'] = 'upcoming'): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state, revision: 'r0',
  sections: [{ id: 'main', name: 'Main', items: ids.map(item) }],
});

const asRecord = (view: ServiceView) => {
  const { id, revision, ...rest } = view;
  return { stamp: { id, updatedAt: revision }, ...rest };
};

beforeEach(() => {
  resetWorkspace();
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
    startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
});

describe('BlankSlideTab', () => {
  it('inserts an empty custom slide at the end and selects it', async () => {
    const bodies: unknown[] = [];
    const fetching: FetchLike = async (url, init) => {
      if (init.body !== undefined) bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith('/content-drift')) return reply(200, successEnvelope([], 'r'));
      return reply(201, successEnvelope(asRecord(viewWith(['a', 'new'])), 'r'));
    };
    setFetching(fetching);
    service.value = viewWith(['a']);
    render(<BlankSlideTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Insert Blank Slide' }));

    await waitFor(() => expect(selection.value.itemId).toBeDefined());
    expect(bodies[0]).toMatchObject({ kind: 'custom-slide', title: 'Blank slide', body: { kind: 'custom-slide', boxes: [] } });
  });

  it('cannot insert into a completed service', () => {
    service.value = viewWith(['a'], 'completed');
    render(<BlankSlideTab />);
    expect((screen.getByRole('button', { name: 'Insert Blank Slide' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
