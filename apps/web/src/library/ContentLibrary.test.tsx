// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { ContentLibrary, isRecent, readLibraryEntries } from './ContentLibrary.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const entry = (id: string, kind: string, title: string, updatedAt: string, archivedAt?: string) =>
  ({ stamp: { id, kind, updatedAt, ...(archivedAt === undefined ? {} : { archivedAt }) }, title });

const SERMON_BODY = {
  sermon: { translations: ['TAOVBSI'], entries: [{ book: 'JHN', chapter: 1, verses: [16], offsets: {} }], notices: [] },
  languages: { ta: { translation: 'TAOVBSI', title: 'கிருபை', points: ['கிருபையின் மேல் கிருபை'] } },
};
const SONG_BODY = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' }, languages: ['ta'],
  sections: [{ id: 'v1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரி' }] }], provenance: { source: 'manual' },
};

let calls: string[];
let bodies: Record<string, unknown>;
let routes: Record<string, ReturnType<typeof reply> | ReturnType<typeof reply>[]>;

beforeEach(() => {
  history.replaceState(null, '', '/library');
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage', 'content.edit'], startedAt: '2026-09-13T09:30:00.000Z',
    lastSeenAt: '2026-09-13T09:30:00.000Z', expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  calls = [];
  bodies = {};
  routes = {
    [`GET ${API.library()}`]: ok([
      entry('a', 'song', 'Paadal', daysAgo(2)),
      entry('b', 'song', 'கீதம்', daysAgo(90)),
      entry('c', 'sermon', 'Grace', daysAgo(1)),
      entry('d', 'reading', 'John 3:16', daysAgo(1)),
    ]),
    [`GET ${API.library({ kind: 'song' })}`]: ok([entry('a', 'song', 'Paadal', daysAgo(2)), entry('b', 'song', 'கீதம்', daysAgo(90))]),
    [`GET ${API.library({ archived: true })}`]: ok([entry('z', 'slideGroup', 'Old group', daysAgo(5), daysAgo(4))]),
    [`GET ${API.library({ q: 'zzz' })}`]: ok([]),
    [`GET ${API.contentHistory('sermon', 'c')}`]: ok([{}, {}, {}]),
    [`GET ${API.contentHistory('song', 'a')}`]: ok([{}]),
    [`GET ${API.sermon('c')}`]: ok({ stamp: { id: 'c' }, title: 'Grace', revision: 3, body: SERMON_BODY }),
    [`GET ${API.song('a')}`]: ok({ stamp: { id: 'a', updatedAt: 'u' }, title: 'Paadal', revision: 1, body: SONG_BODY }),
    [`GET ${API.libraryEntry('c')}`]: ok(entry('c', 'sermon', 'Grace', daysAgo(1))),
    [`GET ${API.contentLanguages}`]: ok([]),
    [`GET ${API.slideLabels}`]: ok([]),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    if (typeof init.body === 'string') bodies[key] = JSON.parse(init.body);
    const found = routes[key];
    const route = Array.isArray(found) ? found.shift() : found;
    if (route === undefined) throw new Error(`No reply for ${key}`);
    return route;
  };
  setFetching(fetching);
});

afterEach(() => history.replaceState(null, '', '/'));

describe('ContentLibrary', () => {
  it('filters by type on the server and by recent use on the client', async () => {
    render(<ContentLibrary />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Grace/u })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'song' } });
    await waitFor(() => expect(calls.at(-1)).toContain('kind=song'));
    expect(await screen.findByText('கீதம்')).toBeTruthy();
    expect(screen.queryByText('Grace')).toBeNull();

    fireEvent.click(screen.getByLabelText('Recently used'));
    expect(screen.queryByText('கீதம்')).toBeNull();
    expect(screen.getByText('Paadal')).toBeTruthy();
  });

  it('sets lang on Tamil and Latin titles and shows archived entries on request', async () => {
    render(<ContentLibrary />);
    expect((await screen.findByText('கீதம்')).getAttribute('lang')).toBe('ta');
    expect(screen.getByText('Paadal').getAttribute('lang')).toBe('ta-Latn');
    expect(screen.getByText('Paadal').getAttribute('title')).toBe('Paadal');

    fireEvent.click(screen.getByLabelText('Show archived'));
    const old = await screen.findByRole('button', { name: /Old group.*Archived/u });
    fireEvent.click(old);
    expect(screen.getByRole('region', { name: 'Old group' }).textContent).toContain('Slide group · Archived');
  });

  it('archives the picked entry after a dialog naming what still uses it, then reloads the list', async () => {
    routes[`GET ${API.libraryDependents('a')}`] = ok({ count: 3, approximate: false, services: 2, templates: 1 });
    routes[`PATCH ${API.libraryStatus('a')}`] = ok(entry('a', 'song', 'Paadal', daysAgo(0), daysAgo(0)));
    render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Paadal/u }));
    const before = calls.filter((call) => call === `GET ${API.library()}`).length;
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Paadal?' });
    expect(await screen.findByText('Used by 2 services and 1 template.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(dialog.isConnected).toBe(false);
    expect(bodies[`PATCH ${API.libraryStatus('a')}`]).toEqual({ archived: true });
    expect(screen.getByRole('region', { name: 'Paadal' }).textContent).toContain('Song · Archived');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    await waitFor(() => expect(calls.filter((call) => call === `GET ${API.library()}`).length).toBe(before + 1));
  });

  it('says plainly when nothing uses the entry, and when that could not be checked', async () => {
    routes[`GET ${API.libraryDependents('a')}`] = [
      ok({ count: 0, approximate: false, services: 0, templates: 0 }),
      reply(500, errorEnvelope('internal', 'broken', 'r')),
    ];
    render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Paadal/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('No service or template uses it.')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('What uses it could not be checked.')).toBeTruthy();
  });

  it('restores an archived entry without asking what uses it', async () => {
    routes[`PATCH ${API.libraryStatus('z')}`] = ok(entry('z', 'slideGroup', 'Old group', daysAgo(0)));
    render(<ContentLibrary />);
    fireEvent.click(screen.getByLabelText('Show archived'));
    fireEvent.click(await screen.findByRole('button', { name: /Old group/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByRole('alertdialog', { name: 'Restore Old group?' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bodies[`PATCH ${API.libraryStatus('z')}`]).toEqual({ archived: false });
    expect(calls.some((call) => call.includes('/dependents'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('keeps the dialog open with the refusal when the server refuses the change', async () => {
    routes[`GET ${API.libraryDependents('a')}`] = ok({ count: 0, approximate: false, services: 0, templates: 0 });
    routes[`PATCH ${API.libraryStatus('a')}`] = reply(409, errorEnvelope('entity.conflict', 'a is already archived', 'r'));
    render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Paadal/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: a is already archived');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('offers no archive action to a session that may not edit content', async () => {
    session.value = { ...session.value!, permissions: ['services.manage'] };
    render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Paadal/u }));
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('refetches on focus', async () => {
    render(<ContentLibrary />);
    await screen.findByText('Grace');
    const before = calls.filter((call) => call === `GET ${API.library()}`).length;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(calls.filter((call) => call === `GET ${API.library()}`).length).toBe(before + 1));
  });

  it('opens a sermon read-only, records it in the address, and reopens it on reload', async () => {
    const { unmount } = render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Grace/u }));
    expect(await screen.findByText('Revision 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('கிருபையின் மேல் கிருபை')).toBeTruthy();
    expect(location.search).toBe('?open=c');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    unmount();

    render(<ContentLibrary />);
    expect(await screen.findByRole('region', { name: 'Grace' })).toBeTruthy();
    expect(await screen.findByText('கிருபையின் மேல் கிருபை')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Paadal/u }));
    expect(location.search).toBe('');
    expect(await screen.findByText('Revision 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByDisplayValue('பாடல்')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /John 3:16/u }));
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('shows an unreadable sermon when opened', async () => {
    routes[`GET ${API.sermon('c')}`] = reply(404, errorEnvelope('entity.not_found', 'Gone.', 'r'));
    render(<ContentLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /Grace/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('entity.not_found')).toBeTruthy();
  });

  it('shows the empty library, no match, and an error with Try Again', async () => {
    routes[`GET ${API.library()}`] = [reply(500, errorEnvelope('server.error', 'No.', 'r')), ok([])];
    render(<ContentLibrary />);
    expect(await screen.findByText('server.error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('heading', { name: 'The library is empty' })).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Search the library'), { target: { value: ' zzz ' } });
    expect(await screen.findByText('No matching content')).toBeTruthy();
  });
});

describe('library helpers', () => {
  it('reads entries strictly and judges recent use by the last change', () => {
    expect(readLibraryEntries({}).ok).toBe(false);
    expect(readLibraryEntries([{ stamp: { id: 'x', kind: 'nope' }, title: 't' }]).ok).toBe(false);
    expect(readLibraryEntries([null]).ok).toBe(false);
    const read = readLibraryEntries([{ stamp: { id: 'x', kind: 'song' }, title: 't' }]);
    expect(read).toEqual({ ok: true, value: [{ id: 'x', kind: 'song', title: 't', updatedAt: '', archived: false }] });
    expect(isRecent({ id: 'x', kind: 'song', title: 't', updatedAt: '', archived: false }, Date.now())).toBe(false);
  });
});
