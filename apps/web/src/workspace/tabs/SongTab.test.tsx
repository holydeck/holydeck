// @vitest-environment happy-dom

import { createHash } from 'node:crypto';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { revisionAddress, revisionBytes } from '@holydeck/contracts/revisions';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../../api.js';
import { API } from '../../api-routes.js';
import { session } from '../../app-state.js';
import { setFetching } from '../../request.js';
import { resetWorkspace, selection, service } from '../../state/workspace-store.js';
import type { ServiceView } from '../service-data.js';
import { addressOf, generatedGroupOf, latestGroupRef, readSlideGroup } from './song-sources.js';
import { SongTab, titleLang } from './SongTab.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'main', name: 'Main', items: [] }],
};
const viewRecord = (items: ServiceItem[]) => ({ stamp: { id: 's1', updatedAt: 'r1' }, ...view, sections: [{ id: 'main', name: 'Main', items }] });

const SONG_BODY = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' }, languages: ['ta'],
  sections: [{ id: 'v1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரி' }] }], provenance: { source: 'manual' },
};
const groupBody = (songId: string, label: string) => ({
  mode: 'generated', enabled: true, slideLayoutId: 'L1',
  generatedFrom: { songId, songRevision: 2, slideLayoutId: 'L1', slideLayoutRevision: 4 },
  slides: [{ id: `x-${label}`, enabled: true, label, languageBlocks: [{ id: 'b', languageKey: 'ta', text: 'வரி' }] }],
});
const group = (id: string, songId: string, label: string, updatedAt = '2026-09-20T00:00:00.000Z') =>
  ({ stamp: { id, updatedAt }, title: 'Paadal', body: groupBody(songId, label) });

const address = (body: unknown): string =>
  revisionAddress(createHash('sha256').update(revisionBytes(body as Readonly<Record<string, unknown>>)).digest('hex'));

const SONGS = `GET ${API.library({ kind: 'song' })}`;
const GROUPS = `GET ${API.library({ kind: 'slideGroup', q: 'Paadal' })}`;
const INSERT = `POST ${API.sectionItems('s1', 'main')}`;

let routes: Record<string, ReturnType<typeof reply>>;
let bodies: Map<string, unknown>;

const signedIn = (permissions: string[]) => ({
  account: me, actor: `account:${me.id}`, permissions, startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication' as const, csrf: 'c'.repeat(43), slots: [],
});

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn(['services.manage', 'content.edit']);
  service.value = view;
  bodies = new Map();
  routes = {
    [SONGS]: ok([{ stamp: { id: 'song1' }, title: 'Paadal' }, { stamp: { id: 'song2' }, title: 'கீதம்' }]),
    [`GET ${API.song('song1')}`]: ok({ stamp: { id: 'song1', updatedAt: 'u' }, title: 'Paadal', revision: 2, body: SONG_BODY }),
    [GROUPS]: ok([{ stamp: { id: 'g1' }, title: 'Paadal' }, { stamp: { id: 'g2' }, title: 'Paadal' }, { stamp: { id: 'g3' }, title: 'Paadal' }]),
    [`GET ${API.slideGroup('g1')}`]: ok(group('g1', 'song1', 'Verse 1')),
    [`GET ${API.slideGroup('g2')}`]: ok(group('g2', 'other', 'Other')),
    [`GET ${API.slideGroup('g3')}`]: ok(group('g3', 'song1', 'Older', '2026-09-01T00:00:00.000Z')),
    [`GET ${API.slideLayouts()}`]: ok([{ stamp: { id: 'L1' }, name: 'Lyrics' }, { stamp: { id: 'L2' }, name: 'Big' }]),
    [`GET ${API.slideLayout('L2')}`]: ok({ stamp: { id: 'L2' }, name: 'Big', revision: 4, body: { boxes: [] } }),
    [`POST ${API.songSlides('song1')}`]: ok(group('g1', 'song1', 'Chorus')),
    [`GET ${API.contentHistory('slideGroup', 'g1')}`]: ok([group('g1', 'song1', 'Verse 1'), group('g1', 'song1', 'Chorus')]),
    [INSERT]: reply(201, successEnvelope(viewRecord([]), 'r')),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    if (url.endsWith('/content-drift')) return ok([]);
    if (typeof init.body === 'string') bodies.set(key, JSON.parse(init.body));
    const route = routes[key];
    if (route === undefined) throw new Error(`No reply for ${key}`);
    return route;
  };
  setFetching(fetching);
});

describe('titleLang', () => {
  it('tells Tamil script from romanized Tamil', () => {
    expect(titleLang('கீதம்')).toBe('ta');
    expect(titleLang('Paadal')).toBe('ta-Latn');
  });
});

describe('SongTab', () => {
  it('shows the latest generated slides, regenerates them with a chosen Layout, and inserts the group pinned', async () => {
    render(<SongTab query="" />);
    const paadal = await screen.findByRole('button', { name: 'Paadal' });
    expect(screen.getByText('கீதம்').getAttribute('lang')).toBe('ta');
    fireEvent.click(paadal);

    expect(await screen.findByText('Verse 1')).toBeTruthy();
    expect(paadal.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Older')).toBeNull();

    fireEvent.change(await screen.findByLabelText('Slide layout'), { target: { value: 'L2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Slides' }));
    expect(await screen.findByText('Chorus')).toBeTruthy();
    expect(bodies.get(`POST ${API.songSlides('song1')}`)).toEqual({ songRevision: 2, slideLayoutId: 'L2', slideLayoutRevision: 4, slideGroupId: 'g1' });

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(selection.value.itemId).toBeDefined());
    expect(bodies.get(INSERT)).toMatchObject({
      kind: 'song', title: 'Paadal', content: { id: 'g1', revision: 2, hash: address(groupBody('song1', 'Chorus')) },
    });
  });

  it('asks for slides first when a song has none, and cannot generate without content rights', async () => {
    session.value = signedIn(['services.manage']);
    routes[GROUPS] = ok([]);
    render(<SongTab query="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paadal' }));
    expect(await screen.findByText('Generate slides for this song before adding it.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByLabelText('Slide layout');
    expect((screen.getByRole('button', { name: 'Generate Slides' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a refused generation, whether the Layout or the generation is refused', async () => {
    routes[`GET ${API.slideLayout('L1')}`] = reply(404, errorEnvelope('entity.not_found', 'Gone.', 'r'));
    render(<SongTab query="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paadal' }));
    await screen.findByLabelText('Slide layout');
    fireEvent.click(screen.getByRole('button', { name: 'Generate Slides' }));
    expect(await screen.findByText('entity.not_found')).toBeTruthy();

    routes[`GET ${API.slideLayout('L1')}`] = ok({ stamp: { id: 'L1' }, name: 'Lyrics', revision: 1, body: { boxes: [] } });
    routes[`POST ${API.songSlides('song1')}`] = reply(409, errorEnvelope('entity.state_conflict', 'Stale.', 'r'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Slides' }));
    expect(await screen.findByText('entity.state_conflict')).toBeTruthy();
  });

  it('opens the Song editor for a new song and for the picked one', async () => {
    routes[`GET ${API.contentLanguages}`] = ok([]);
    routes[`GET ${API.slideLabels}`] = ok([]);
    render(<SongTab query="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Song' }));
    expect(screen.getByRole('button', { name: 'Create Song' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Paadal' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Song' }));
    expect(await screen.findByDisplayValue('பாடல்')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Song' })).toBeNull();
  });

  it('says when nothing matches, when there is no Layout, and when the songs cannot be read', async () => {
    routes[`GET ${API.library({ kind: 'song', q: 'zzz' })}`] = ok([]);
    const { unmount } = render(<SongTab query="zzz" />);
    expect(await screen.findByText(/No match|Keine/u)).toBeTruthy();
    unmount();

    routes[SONGS] = ok([]);
    const empty = render(<SongTab query="" />);
    expect(await screen.findByText('Search or pick a song to add it to this service.')).toBeTruthy();
    empty.unmount();

    routes[SONGS] = reply(503, errorEnvelope('library.unavailable', 'Down.', 'r'));
    render(<SongTab query="" />);
    expect(await screen.findByText('library.unavailable')).toBeTruthy();
  });

  it('offers no Layout when there is none', async () => {
    routes[`GET ${API.slideLayouts()}`] = ok([]);
    render(<SongTab query="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paadal' }));
    expect(await screen.findByText('No slide layout to choose.')).toBeTruthy();
  });
});

describe('song sources', () => {
  it('reads nothing from a malformed group, history or library answer', async () => {
    expect(readSlideGroup({ title: 'x' })).toBeUndefined();
    routes[`GET ${API.contentHistory('slideGroup', 'g9')}`] = ok([]);
    await expect(latestGroupRef('g9')).resolves.toBeUndefined();
    routes[`GET ${API.contentHistory('slideGroup', 'g9')}`] = ok(['nope']);
    await expect(latestGroupRef('g9')).resolves.toBeUndefined();
    routes[GROUPS] = ok('nope');
    await expect(generatedGroupOf({ id: 'song1', title: 'Paadal' })).resolves.toBeUndefined();
    await expect(addressOf({ circular: 1n })).resolves.toBeUndefined();
  });
});
