// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../../api.js';
import { API } from '../../api-routes.js';
import { session } from '../../app-state.js';
import { setFetching } from '../../request.js';
import { resetWorkspace, selection, service } from '../../state/workspace-store.js';
import type { ServiceView } from '../service-data.js';
import { BibleTab, readingTitle, readScriptureHits } from './BibleTab.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const signedIn = (permissions: string[]): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions,
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
});

type Reply = { status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({ status, json: async (): Promise<unknown> => body });

const item = (id: string): ServiceItem => ({ id, kind: 'custom-slide', title: `Item ${id}`, enabled: true, content: undefined });
const viewWith = (ids: string[]): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'main', name: 'Main', items: ids.map(item) }],
});

const asRecord = (view: ServiceView) => {
  const { id, revision, ...rest } = view;
  return { stamp: { id, updatedAt: revision }, ...rest };
};

const translation = (abbreviation: string, title: string) => ({
  abbreviation, id: abbreviation.length, title, language: 'en', syncedChapters: 1, canonChapters: 1, cached: true,
});
const TRANSLATIONS = { translations: ['KJV', 'TAOVBSI', 'NIV', 'ESV', 'NASB'].map((abbr) => translation(abbr, `${abbr} Bible`)) };
const canon = (abbr: string) => ({
  canon: {
    translation: abbr, source: 'bundled',
    books: [
      { usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: 'GEN.1', label: '1' }] },
      { usfm: 'JHN', canon: 'nt', name: 'John', chapters: [{ id: 'JHN.3', label: '3' }] },
    ],
  },
});
const verses = (text: string) => ({
  verses: { verses: { '16': text }, citation: 'John 3:16', revision: 1, fetchedAt: '2026-09-23T10:00:00.000Z', source: 'cache' },
});

type Stub = { calls: string[]; bodies: Map<string, unknown> };

function stubBible(extra: Record<string, Reply | Reply[]> = {}): Stub {
  const stub: Stub = { calls: [], bodies: new Map() };
  const map: Record<string, Reply | Reply[]> = {
    [`GET ${API.translations}`]: reply(200, successEnvelope(TRANSLATIONS, 'r')),
    [`GET ${API.translationOffsets}`]: reply(200, successEnvelope({ offsets: [{ abbr: 'KJV', offset: 2 }] }, 'r')),
    ...Object.fromEntries(['KJV', 'TAOVBSI', 'NIV', 'ESV', 'NASB'].flatMap((abbr) => [
      [`GET ${API.canon(abbr)}`, reply(200, successEnvelope(canon(abbr), 'r'))],
      [`GET ${API.verses(abbr, 'JHN', 3, '16')}`, reply(200, successEnvelope(verses(`${abbr}: For God so loved`), 'r'))],
    ])),
    ...extra,
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    stub.calls.push(key);
    if (init.body !== undefined) stub.bodies.set(key, JSON.parse(String(init.body)));
    const entry = map[key];
    const response = Array.isArray(entry) ? entry.shift() : entry;
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };
  setFetching(fetching);
  return stub;
}

async function pickJohn316(): Promise<void> {
  await screen.findByRole('option', { name: 'John' });
  fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'JHN' } });
  fireEvent.input(screen.getByLabelText('Chapter'), { target: { value: '3' } });
  fireEvent.input(screen.getByLabelText('Verses'), { target: { value: '16' } });
}

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn(['services.manage']);
  service.value = viewWith(['a', 'b']);
});

describe('BibleTab', () => {
  it('inserts a reading at the chosen location only on Insert, then selects it', async () => {
    const stub = stubBible({
      'POST /api/v1/services/s1/sections/main/items': reply(201, successEnvelope(asRecord(viewWith(['a', 'b', 'new'])), 'r')),
    });
    render(<BibleTab query="" />);

    expect(await screen.findByText('Search or pick a passage to add it to this service.')).toBeTruthy();
    await pickJohn316();
    expect(await screen.findByText('KJV: For God so loved')).toBeTruthy();
    expect(screen.getByText('Verse offset: 2')).toBeTruthy();
    expect(stub.calls.filter((call) => call.startsWith('POST'))).toEqual([]);

    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    await waitFor(() => expect(selection.value.itemId).toBeDefined());
    expect(stub.bodies.get('POST /api/v1/services/s1/sections/main/items')).toMatchObject({
      kind: 'reading', title: 'John 3:16', body: { kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16' },
    });
    expect(stub.calls.some((call) => call.includes('reorder'))).toBe(false);
  });

  it('caps comparison at three more translations and stacks each passage', async () => {
    stubBible();
    render(<BibleTab query="" />);
    await pickJohn316();

    for (const title of ['TAOVBSI Bible', 'NIV Bible', 'ESV Bible']) fireEvent.click(await screen.findByRole('checkbox', { name: title }));

    expect(screen.getByText('Up to four translations can be shown together.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'NASB Bible' }) as HTMLInputElement).disabled).toBe(true);
    expect(await screen.findByText('ESV: For God so loved')).toBeTruthy();
    expect(screen.getAllByText('Verse offset: 0')).toHaveLength(3);

    fireEvent.click(screen.getByRole('checkbox', { name: 'ESV Bible' }));
    expect((screen.getByRole('checkbox', { name: 'NASB Bible' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('shows the offset editor only with settings.manage, and saves the new offset', async () => {
    stubBible();
    const { unmount } = render(<BibleTab query="" />);
    await screen.findByRole('option', { name: 'John' });
    expect(screen.queryByLabelText('Edit Offset')).toBeNull();
    unmount();

    session.value = signedIn(['services.manage', 'settings.manage']);
    const stub = stubBible({ 'PUT /api/v1/translation-offsets/KJV': reply(200, successEnvelope({ offset: { abbr: 'KJV', offset: -1 } }, 'r')) });
    render(<BibleTab query="" />);
    await pickJohn316();
    await screen.findByText('Verse offset: 2');
    fireEvent.input(screen.getByLabelText('Edit Offset'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Offset' }));

    expect(await screen.findByText('Verse offset: -1')).toBeTruthy();
    expect(stub.bodies.get('PUT /api/v1/translation-offsets/KJV')).toEqual({ offset: -1 });
  });

  it('reports a refused offset with its code', async () => {
    session.value = signedIn(['services.manage', 'settings.manage']);
    stubBible({ 'PUT /api/v1/translation-offsets/KJV': reply(403, errorEnvelope('auth.forbidden', 'No.', 'r')) });
    render(<BibleTab query="" />);
    await screen.findByRole('option', { name: 'John' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Offset' }));
    expect(await screen.findByText('auth.forbidden')).toBeTruthy();
  });

  it('narrows the books by the search and says when nothing matches', async () => {
    stubBible();
    const { rerender } = render(<BibleTab query="joh" />);
    await screen.findByRole('option', { name: 'John' });
    expect(screen.queryByRole('option', { name: 'Genesis' })).toBeNull();

    rerender(<BibleTab query="zzz" />);
    expect(screen.getByRole('heading', { name: 'No matching content' })).toBeTruthy();
    expect(screen.getByText('Change the search or remove a filter.')).toBeTruthy();
  });

  it('shows loading, then an error with its code, and Try Again reads the translations again', async () => {
    stubBible({
      [`GET ${API.translations}`]: [
        reply(404, errorEnvelope('corpus.unavailable', 'Down.', 'r')),
        reply(200, successEnvelope(TRANSLATIONS, 'r')),
      ],
    });
    render(<BibleTab query="" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText('corpus.unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('option', { name: 'John' })).toBeTruthy();
  });

  it('shows a passage that cannot be read, and a canon that cannot be read', async () => {
    stubBible({
      [`GET ${API.verses('KJV', 'JHN', 3, '16')}`]: reply(404, errorEnvelope('corpus.passage_missing', 'No.', 'r')),
    });
    render(<BibleTab query="" />);
    await pickJohn316();
    expect(await screen.findByText('corpus.passage_missing')).toBeTruthy();
  });

  it('keeps Insert off until the reading is complete, and while the service is read-only', async () => {
    stubBible();
    session.value = signedIn([]);
    render(<BibleTab query="" />);
    await pickJohn316();
    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('readingTitle', () => {
  it('names the book, chapter and verses, falling back to the book code', () => {
    const books = [{ usfm: 'JHN', canon: 'nt', name: 'John', chapters: [] }];
    const draft = { translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16' };
    expect(readingTitle(draft, books)).toBe('John 3:16');
    expect(readingTitle({ ...draft, book: 'XYZ', verses: '1-2' }, books)).toBe('XYZ 3:1-2');
  });

  it('finds a phrase and opens the passage', async () => {
    const hit = (abbr: string, verse: number, text: string) => ({
      reference: { abbr, book: 'JHN', chapter: 3, verses: [verse], revision: 1 }, text, phrase: 'so loved', occurrences: 1, bookOrder: 43,
    });
    const long = `For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him ${'should '.repeat(4)}`;
    stubBible({
      [`GET ${API.scriptureSearch('so loved')}`]: [
        reply(503, errorEnvelope('corpus.unavailable', 'Down.', 'r')),
        reply(200, successEnvelope([hit('KJV', 16, long), hit('NIV', 16, 'For God so loved')], 'r')),
      ],
      [`GET ${API.scriptureSearch('nothing here')}`]: reply(200, successEnvelope([], 'r')),
    });
    render(<BibleTab query="" />);
    const field = await screen.findByRole('searchbox', { name: 'Search Scripture' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.input(field, { target: { value: ' so loved ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText('corpus.unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    const result = await screen.findByRole('button', { name: /^KJV John 3:16 — For God so loved/u });
    expect(result.textContent?.endsWith('…')).toBe(true);
    expect(result.getAttribute('title')).toBe(long);
    expect(screen.queryByRole('button', { name: /^NIV/u })).toBeNull();

    fireEvent.click(result);
    expect(await screen.findByText('KJV: For God so loved')).toBeTruthy();
    expect((screen.getByLabelText('Book') as HTMLSelectElement).value).toBe('JHN');
    expect((screen.getByLabelText('Verses') as HTMLInputElement).value).toBe('16');

    fireEvent.input(field, { target: { value: 'nothing here' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    expect(await screen.findByText('No matching content')).toBeTruthy();
  });
});

describe('readScriptureHits', () => {
  it('refuses anything but a list of complete hits', () => {
    expect(readScriptureHits({}).ok).toBe(false);
    expect(readScriptureHits([{ reference: 'JHN 3:16', text: 'x' }]).ok).toBe(false);
    expect(readScriptureHits([{ reference: { abbr: 'KJV', book: 'JHN', chapter: 3, verses: ['16'] }, text: 'x' }]).ok).toBe(false);
    expect(readScriptureHits([null]).ok).toBe(false);
  });
});
