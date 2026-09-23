// @vitest-environment happy-dom

import { createHash } from 'node:crypto';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { revisionAddress, revisionBytes } from '@holydeck/contracts/revisions';

import type { FetchLike } from '../../api.js';
import { API } from '../../api-routes.js';
import { session } from '../../app-state.js';
import { setFetching } from '../../request.js';
import { resetWorkspace, selection, service } from '../../state/workspace-store.js';
import { readSermon, SermonTab } from './SermonTab.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));

const LONG = `Grace upon grace ${'and more grace '.repeat(8)}`.trim();
const BODY = {
  sermon: { translations: ['TAOVBSI'], entries: [{ book: 'JHN', chapter: 1, verses: [16, 17], offsets: {} }, { book: 'ROM', chapter: 5, verses: [8], offsets: {} }], notices: [] },
  languages: { ta: { translation: 'TAOVBSI', title: 'கிருபை', points: ['கிருபையின் மேல் கிருபை'] } },
};
const address = (body: unknown): string =>
  revisionAddress(createHash('sha256').update(revisionBytes(body as Readonly<Record<string, unknown>>)).digest('hex'));

const LIST = `GET ${API.library({ kind: 'sermon' })}`;
const INSERT = `POST ${API.sectionItems('s1', 'main')}`;
let routes: Record<string, ReturnType<typeof reply> | ReturnType<typeof reply>[]>;
let bodies: Map<string, unknown>;

beforeEach(() => {
  resetWorkspace();
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage'], startedAt: '2026-09-13T09:30:00.000Z',
    lastSeenAt: '2026-09-13T09:30:00.000Z', expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  const view = { id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming' as const, revision: 'r0', sections: [{ id: 'main', name: 'Main', items: [] }] };
  service.value = view;
  bodies = new Map();
  routes = {
    [LIST]: ok([{ stamp: { id: 'ser1' }, title: LONG }, { stamp: { id: 'ser2' }, title: 'Broken' }]),
    [`GET ${API.sermon('ser1')}`]: ok({ stamp: { id: 'ser1' }, title: LONG, revision: 3, at: '2026-09-20T00:00:00.000Z', body: BODY }),
    [`GET ${API.sermon('ser2')}`]: reply(404, errorEnvelope('entity.not_found', 'Gone.', 'r')),
    [INSERT]: reply(201, successEnvelope({ stamp: { id: 's1', updatedAt: 'r1' }, ...view }, 'r')),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    if (url.endsWith('/content-drift')) return ok([]);
    if (typeof init.body === 'string') bodies.set(key, JSON.parse(init.body));
    const entry = routes[key];
    const route = Array.isArray(entry) ? entry.shift() : entry;
    if (route === undefined) throw new Error(`No reply for ${key}`);
    return route;
  };
  setFetching(fetching);
});

describe('SermonTab', () => {
  it('inserts a sermon from the library search, insert-only', async () => {
    render(<SermonTab query="" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    const row = await screen.findByRole('button', { name: LONG });
    expect(row.querySelector('.truncate')?.getAttribute('title')).toBe(LONG);
    const insert = screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement;
    expect(insert.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Broken' }));
    expect(await screen.findByText('entity.not_found')).toBeTruthy();
    expect(insert.disabled).toBe(true);

    fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'Outline' })).toBeTruthy();
    expect(screen.getByText('கிருபையின் மேல் கிருபை').getAttribute('lang')).toBe('ta');
    expect(screen.getByText('ROM 5:8')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit/u })).toBeNull();

    fireEvent.click(insert);
    await waitFor(() => expect(selection.value.itemId).toBeDefined());
    expect(bodies.get(INSERT)).toMatchObject({ kind: 'sermon', title: LONG, content: { id: 'ser1', revision: 3, hash: address(BODY) } });
  });

  it('shows guidance, no match, and a refused list with Try Again', async () => {
    routes[LIST] = [reply(500, errorEnvelope('server.error', 'No.', 'r')), ok([])];
    const { unmount } = render(<SermonTab query="" />);
    expect(await screen.findByText('server.error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Search or pick a sermon to add it to this service.')).toBeTruthy();
    unmount();

    routes[`GET ${API.library({ kind: 'sermon', q: 'zzz' })}`] = ok([]);
    render(<SermonTab query=" zzz " />);
    expect(await screen.findByText('No matching content')).toBeTruthy();
  });
});

describe('readSermon', () => {
  it('refuses what is not a sermon record and reads one without points', () => {
    expect(readSermon(null)).toBeUndefined();
    expect(readSermon({ stamp: { id: 1 }, title: 't', revision: 1, body: { sermon: {} } })).toBeUndefined();
    expect(readSermon({ stamp: { id: 'x' }, title: 't', revision: 1, body: { sermon: { entries: [{ book: 'GEN', chapter: 1, verses: 'x' }] } } }))
      .toMatchObject({ outline: [{ passage: 'GEN 1:' }] });
  });
});
