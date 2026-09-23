// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SongBody } from '@holydeck/contracts/songs';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { SongEditor } from './SongEditor.js';

const me: AccountRecord = {
  id: 'a1', name: 'andru', displayName: 'Andru', role: 'admin', createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const BODY: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: ['ta', 'ta-Latn'],
  sections: [{ id: 'v1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரி' }, { languageKey: 'ta-Latn', text: 'vari' }] }],
  provenance: { source: 'import', importer: 'powerpoint', importedAt: '2026-09-01T00:00:00.000Z', reference: 'deck.pptx' },
};

const song = (revision: number, body: SongBody = BODY) =>
  ({ stamp: { id: 'song1', updatedAt: '2026-09-20T00:00:00.000Z' }, title: 'Paadal', revision, at: '2026-09-20T00:00:00.000Z', body });

const LANGUAGES = [
  { stamp: { id: 'k1' }, key: 'ta', displayName: 'Tamil', script: 'Taml', fallbackFont: 'Noto Sans Tamil' },
  { stamp: { id: 'k2' }, key: 'ta-Latn', displayName: 'Tamil (Latin)', script: 'Latn', fallbackFont: 'Inter' },
  { stamp: { id: 'k3' }, key: 'en', displayName: 'English', script: 'Latn', fallbackFont: 'Inter' },
];

type Reply = ReturnType<typeof reply> | { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
let routes: Record<string, () => Reply>;
let calls: { key: string; body: unknown }[];

const coEditing = (contentId: string): Record<string, () => unknown> => ({
  [`POST /api/v1/presence/${encodeURIComponent(contentId)}`]: () => reply(200, successEnvelope({}, 'r')),
  [`GET /api/v1/presence/${encodeURIComponent(contentId)}`]: () =>
    reply(200, successEnvelope([{
      contentId, actor: 'account:other', displayName: 'Chioma Obi',
      enteredAt: '2026-09-14T09:00:00.000Z', heartbeatAt: '2026-09-14T09:00:00.000Z', expiresAt: '2026-09-14T09:01:00.000Z',
    }], 'r')),
  [`DELETE /api/v1/presence/${encodeURIComponent(contentId)}`]: () => ({ status: 204, json: async (): Promise<unknown> => undefined }),
  [`GET /api/v1/content/${encodeURIComponent(contentId)}/conflicts`]: () =>
    reply(200, successEnvelope({
      outstanding: [{
        kind: 'shelved', contentId, sequence: 1, attempted: 3, origin: 'autosave', body: {},
        at: '2026-09-14T09:00:00.000Z', actor: 'account:other', correlationId: 'req-1',
      }],
      entries: [],
    }, 'r')),
  [`POST /api/v1/content/${encodeURIComponent(contentId)}/conflicts/${encodeURIComponent(`${contentId}#1`)}/resolve`]: () =>
    reply(200, successEnvelope({ appended: true, revision: 3 }, 'r')),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  calls = [];
  session.value = {
    account: me,
    actor: 'account:a1', permissions: ['content.edit'], startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  routes = {
    [`GET ${API.contentLanguages}`]: () => reply(200, successEnvelope(LANGUAGES, 'r')),
    [`GET ${API.slideLabels}`]: () => reply(200, successEnvelope([{ stamp: { id: 'l1' }, name: 'Chorus' }], 'r')),
    [`GET ${API.song('song1')}`]: () => reply(200, successEnvelope(song(1), 'r')),
    [`POST ${API.songs}`]: () => reply(201, successEnvelope(song(1), 'r')),
    [`PUT ${API.song('song1')}`]: () => reply(200, successEnvelope(song(2), 'r')),
    [`GET ${API.songRaw('song1')}`]: () => ({ status: 200, json: async (): Promise<unknown> => ({}), text: async (): Promise<string> => 'titles: {}\n' }),
    [`PUT ${API.songRaw('song1')}`]: () => reply(200, successEnvelope({}, 'r')),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`No reply for ${key}`);
    const body = typeof init.body === 'string' && init.headers?.['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
    calls.push({ key, body });
    return route();
  };
  setFetching(fetching);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const sent = (key: string): unknown[] => calls.filter((call) => call.key === key).map((call) => call.body);

describe('SongEditor', () => {
  it('creates a new song, then autosaves each change 800 ms later against the revision it holds', async () => {
    const onChange = vi.fn();
    render(<SongEditor onChange={onChange} />);
    await settle();
    expect((screen.getByRole('tab', { name: 'Raw YAML' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Create Song' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.input(screen.getByLabelText('Title (Romanized Tamil)'), { target: { value: 'Paadal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Song' }));
    await settle();
    expect(sent(`POST ${API.songs}`)).toEqual([{ title: 'Paadal', body: expect.objectContaining({ titles: { tamil: '', romanized: 'Paadal' } }) }]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'song1', revision: 1 }));
    expect(screen.queryByRole('button', { name: 'Create Song' })).toBeNull();

    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'பாடல்' } });
    await settle(799);
    expect(sent(`PUT ${API.song('song1')}`)).toEqual([]);
    await settle(1);
    await settle();
    expect(sent(`PUT ${API.song('song1')}`)).toEqual([{ expectedRevision: 1, body: expect.objectContaining({ titles: { tamil: 'பாடல்', romanized: 'Paadal' } }) }]);
    expect(screen.getByRole('status').textContent).toBe('Saved');

    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'புதிய' } });
    await settle(800);
    await settle();
    expect(sent(`PUT ${API.song('song1')}`)[1]).toMatchObject({ expectedRevision: 2 });
  });

  it('shows a refused create', async () => {
    routes[`POST ${API.songs}`] = () => reply(403, errorEnvelope('auth.forbidden', 'No.', 'r'));
    render(<SongEditor />);
    await settle();
    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'பாடல்' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Song' }));
    await settle();
    expect(screen.getByText('auth.forbidden')).toBeTruthy();
  });

  it('stops saving on a newer revision until the latest is reloaded', async () => {
    routes[`PUT ${API.song('song1')}`] = () => reply(409, errorEnvelope('entity.state_conflict', 'Stale.', 'r'));
    render(<SongEditor songId="song1" />);
    await settle();
    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'மாற்றம்' } });
    await settle(800);
    await settle();
    expect(screen.getByText('Someone saved a newer version. Reload to continue from it.')).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'மீண்டும்' } });
    await settle(2000);
    expect(sent(`PUT ${API.song('song1')}`)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload Latest' }));
    await settle();
    expect(sent(`GET ${API.song('song1')}`)).toHaveLength(2);
    expect((screen.getByLabelText('Title (Tamil)') as HTMLInputElement).value).toBe('பாடல்');
    expect(screen.queryByRole('button', { name: 'Reload Latest' })).toBeNull();
  });

  it('reads the shelf again once a save is shelved, so the losing save is there to settle', async () => {
    Object.assign(routes, coEditing('song1'));
    const conflicts = `GET /api/v1/content/${encodeURIComponent('song1')}/conflicts`;
    const shelved = routes[conflicts]!;
    let reads = 0;
    routes[conflicts] = () => (reads++ === 0 ? reply(200, successEnvelope({ outstanding: [], entries: [] }, 'r')) : shelved());
    routes[`PUT ${API.song('song1')}`] = () => reply(409, errorEnvelope('entity.state_conflict', 'Stale.', 'r'));
    render(<SongEditor songId="song1" />);
    await settle();
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull();

    fireEvent.input(screen.getByLabelText('Title (Tamil)'), { target: { value: 'மாற்றம்' } });
    await settle(800);
    await settle();
    await settle();

    expect(sent(conflicts)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeTruthy();
  });

  it('edits languages, sections and details in the form', async () => {
    render(<SongEditor songId="song1" />);
    await settle();
    expect(screen.getByText(/Imported by powerpoint on 2026-09-01/u)).toBeTruthy();
    expect((screen.getByLabelText('Tamil text') as HTMLTextAreaElement).lang).toBe('ta');

    fireEvent.click(screen.getByRole('button', { name: 'Move Tamil (Latin) up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Language' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move English up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move English down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tamil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Section' }));
    const labels = screen.getAllByLabelText('Label');
    fireEvent.input(labels[1] as HTMLInputElement, { target: { value: 'Chorus' } });
    fireEvent.change(screen.getAllByLabelText('Repeat')[1] as HTMLInputElement, { target: { value: '3' } });
    fireEvent.input(screen.getAllByLabelText('English text')[1] as HTMLTextAreaElement, { target: { value: 'Hallelujah' } });
    fireEvent.change(screen.getAllByLabelText('Repeat')[0] as HTMLInputElement, { target: { value: '0' } });
    fireEvent.input(screen.getByLabelText('Author'), { target: { value: 'A. Writer' } });
    await settle(800);
    await settle();

    expect(sent(`PUT ${API.song('song1')}`)).toEqual([{
      expectedRevision: 1,
      body: {
        ...BODY,
        languages: ['ta-Latn', 'en'],
        sections: [
          { id: 'v1', label: 'Verse 1', text: [{ languageKey: 'ta-Latn', text: 'vari' }] },
          { id: expect.any(String), label: 'Chorus', repeat: { count: 3 }, text: [{ languageKey: 'en', text: 'Hallelujah' }] },
        ],
        metadata: { author: 'A. Writer' },
      },
    }]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove section 2' }));
    expect(screen.getAllByLabelText('Label')).toHaveLength(1);
  });

  it('asks before leaving unsaved raw YAML, and re-reads the song after a raw save', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<SongEditor songId="song1" />);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw YAML' }));
    await settle();
    const area = screen.getByRole('textbox', { name: 'Raw YAML' });
    fireEvent.input(area, { target: { value: 'titles: {x: 1}\n' } });
    await settle();

    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(confirm).toHaveBeenCalledWith('Leave the raw editor? Unsaved YAML will be lost.');
    expect(screen.getByRole('tab', { name: 'Raw YAML' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Validate and Save' }));
    await settle();
    await settle();
    expect(sent(`GET ${API.song('song1')}`)).toHaveLength(2);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByRole('tab', { name: 'Form' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a song that cannot be read', async () => {
    routes[`GET ${API.song('song1')}`] = () => reply(200, successEnvelope({ nope: true }, 'r'));
    render(<SongEditor songId="song1" />);
    await settle();
    expect(screen.getByText('client.unreadable_response')).toBeTruthy();
  });

  it('shows who else is editing and the conflicts left to settle, and reloads after one is settled', async () => {
    Object.assign(routes, coEditing('song1'));
    render(<SongEditor songId="song1" />);
    await settle();
    await settle();
    expect(screen.getByText('Also editing')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Chioma Obi is editing' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep theirs' }));
    await settle();
    await settle();
    expect(sent(`GET ${API.song('song1')}`)).toHaveLength(2);
  });
});
