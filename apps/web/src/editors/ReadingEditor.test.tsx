// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { toasts } from '../components/toast.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import type { ServiceView } from '../workspace/service-data.js';
import { ReadingEditor } from './ReadingEditor.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const reading: ServiceItem = {
  id: 'r1', kind: 'reading', title: 'John 3:16', enabled: true, content: undefined,
  body: { kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16', slideLayout: { id: 'L1', revision: 2 } },
};

const viewWith = (items: ServiceItem[], state: ServiceView['state'] = 'upcoming'): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state, revision: 'r0',
  sections: [{ id: 'main', name: 'Main', items }],
});

const asRecord = (view: ServiceView) => {
  const { id, revision, ...rest } = view;
  return { stamp: { id, updatedAt: revision }, ...rest };
};

const TRANSLATIONS = {
  translations: ['KJV', 'NIV'].map((abbreviation) => ({
    abbreviation, id: 1, title: `${abbreviation} Bible`, language: 'en', syncedChapters: 1, canonChapters: 1, cached: true,
  })),
};
const CANON = {
  canon: {
    translation: 'KJV', source: 'bundled',
    books: [{ usfm: 'JHN', canon: 'nt', name: 'John', chapters: [] }, { usfm: 'ROM', canon: 'nt', name: 'Romans', chapters: [] }],
  },
};

const BODY = `PUT ${API.itemAction('s1', 'r1', 'body')}`;
let puts: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  resetWorkspace();
  toasts.value = [];
  puts = [];
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
    startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  service.value = viewWith([reading]);
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    if (key === BODY) {
      puts.push(JSON.parse(String(init.body)));
      return reply(200, successEnvelope(asRecord(viewWith([reading])), 'r'));
    }
    if (key === `GET ${API.translations}`) return reply(200, successEnvelope(TRANSLATIONS, 'r'));
    if (key.startsWith('GET /api/v1/translations/') && key.endsWith('/canon')) return reply(200, successEnvelope(CANON, 'r'));
    if (key.endsWith('/content-drift')) return reply(200, successEnvelope([], 'r'));
    throw new Error(`No reply for ${key}`);
  };
  setFetching(fetching);
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

describe('ReadingEditor', () => {
  it('autosaves reading edits once, 800 ms after the last one, keeping the layout', async () => {
    render(<ReadingEditor itemId="r1" />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Reading' })).toBeTruthy();
    expect((screen.getByLabelText('Book') as HTMLSelectElement).value).toBe('JHN');

    fireEvent.input(screen.getByLabelText('Verses'), { target: { value: '16-17' } });
    await settle(500);
    fireEvent.input(screen.getByLabelText('Verses'), { target: { value: '16-18' } });
    await settle(799);
    expect(puts).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('Saving…');

    await settle(1);
    await settle(2000);
    expect(puts).toEqual([{ kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16-18', slideLayout: { id: 'L1', revision: 2 } }]);
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('Save Checkpoint saves at once, and does nothing before any edit', async () => {
    render(<ReadingEditor itemId="r1" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save Checkpoint' }));
    await settle();
    expect(puts).toEqual([]);

    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'ROM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Checkpoint' }));
    await settle();
    expect(puts).toHaveLength(1);
    await settle(1000);
    expect(puts).toHaveLength(1);
  });

  it('never saves an incomplete reading', async () => {
    render(<ReadingEditor itemId="r1" />);
    await settle();
    fireEvent.input(screen.getByLabelText('Chapter'), { target: { value: '' } });
    await settle(1000);
    expect(puts).toEqual([]);
  });

  it('undoes and redoes a field change, naming the field in a toast', async () => {
    render(<ReadingEditor itemId="r1" />);
    await settle();
    const book = screen.getByLabelText('Book') as HTMLSelectElement;
    fireEvent.change(book, { target: { value: 'ROM' } });
    book.focus();

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect((screen.getByLabelText('Book') as HTMLSelectElement).value).toBe('JHN');
    expect(toasts.value.at(-1)?.message).toBe('Undid: Book change');

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });
    expect((screen.getByLabelText('Book') as HTMLSelectElement).value).toBe('ROM');
    expect(toasts.value.at(-1)?.message).toBe('Redid: Book change');
  });

  it('merges quick typing in one field into one undo step', async () => {
    render(<ReadingEditor itemId="r1" />);
    await settle();
    fireEvent.input(screen.getByLabelText('Verses'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Verses'), { target: { value: '1-2' } });
    (screen.getByLabelText('Book') as HTMLSelectElement).focus();
    fireEvent.keyDown(document, { key: 'z', metaKey: true });
    expect((screen.getByLabelText('Verses') as HTMLInputElement).value).toBe('16');
  });

  it('is read-only in a completed service, and renders nothing for a non-reading', async () => {
    service.value = viewWith([reading, { id: 'c1', kind: 'custom-slide', title: 'Slide', enabled: true, content: undefined }], 'completed');
    const { container } = render(<><ReadingEditor itemId="r1" /><ReadingEditor itemId="c1" /></>);
    await settle();
    expect((screen.getByLabelText('Verses') as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelectorAll('.reading-editor')).toHaveLength(1);
  });
});
