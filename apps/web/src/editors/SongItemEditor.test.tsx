// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import { API } from '../api-routes.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { SongItemEditor } from './SongItemEditor.js';

const ok = (data: unknown) => ({ status: 200, json: async (): Promise<unknown> => successEnvelope(data, 'r') });

const groupWith = (generatedFrom?: Record<string, unknown>) => ({
  stamp: { id: 'g1', updatedAt: 'u' }, title: 'Paadal',
  body: { mode: generatedFrom === undefined ? 'custom' : 'generated', enabled: true, slideLayoutId: 'L1', slides: [], ...(generatedFrom === undefined ? {} : { generatedFrom }) },
});

const withItem = (content: ServiceItem['content']): void => {
  service.value = {
    id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
    sections: [{ id: 'main', name: 'Main', items: [{ id: 'i1', kind: 'song', title: 'Paadal', enabled: true, content }] }],
  };
};

let routes: Record<string, ReturnType<typeof ok>>;

beforeEach(() => {
  resetWorkspace();
  routes = {
    [`GET ${API.slideGroup('g1')}`]: ok(groupWith({ songId: 'song1' })),
    [`GET ${API.song('song1')}`]: ok({
      stamp: { id: 'song1', updatedAt: 'u' }, title: 'Paadal', revision: 3,
      body: { titles: { tamil: 'பாடல்', romanized: 'Paadal' }, languages: ['ta'], sections: [], provenance: { source: 'manual' } },
    }),
    [`GET ${API.contentLanguages}`]: ok([]),
    [`GET ${API.slideLabels}`]: ok([]),
  };
  setFetching(async (url, init) => {
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    if (route === undefined) throw new Error(`No reply for ${url}`);
    return route;
  });
});

describe('SongItemEditor', () => {
  it('edits the song the item\'s slides were generated from', async () => {
    withItem({ id: 'g1', revision: 1, hash: undefined });
    render(<SongItemEditor itemId="i1" />);
    expect(await screen.findByDisplayValue('Paadal')).toBeTruthy();
  });

  it('says there is no song for a hand-made group or an item without content', async () => {
    routes[`GET ${API.slideGroup('g1')}`] = ok(groupWith());
    withItem({ id: 'g1', revision: 1, hash: undefined });
    const { unmount } = render(<SongItemEditor itemId="i1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    unmount();

    withItem(undefined);
    render(<SongItemEditor itemId="i1" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no song to edit/u);
  });
});
