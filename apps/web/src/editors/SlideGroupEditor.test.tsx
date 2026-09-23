// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { Slide, SlideGroupBody } from '@holydeck/contracts/slide-groups';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { SlideGroupEditor } from './SlideGroupEditor.js';
import { activeSlide, SlideOverrides } from './SlideOverrides.js';

const me: AccountRecord = {
  id: 'a1', name: 'andru', displayName: 'Andru', role: 'admin', createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));

type Overrides = Record<string, { readonly layout?: string; readonly background?: string; readonly enabled?: boolean }>;

const slideOf = (id: string, overrides: Overrides): Slide => ({
  id, enabled: overrides[id]?.enabled ?? true, label: `Label ${id}`,
  ...(overrides[id]?.layout === undefined ? {} : { slideLayoutId: overrides[id]?.layout }),
  ...(overrides[id]?.background === undefined ? {} : { background: overrides[id]?.background }),
  languageBlocks: [{ id: `${id}-ta`, languageKey: 'ta', text: `வரி ${id}` }, { id: `${id}-lat`, languageKey: 'ta-Latn', text: `vari ${id}` }],
});

const bodyOf = (slideIds: string[], overrides: Overrides = {}, mode: SlideGroupBody['mode'] = 'custom'): SlideGroupBody => ({
  mode, enabled: true, slideLayoutId: 'L1', slides: slideIds.map((id) => slideOf(id, overrides)),
});

const group = (slideIds: string[], overrides: Overrides = {}, mode: SlideGroupBody['mode'] = 'custom') =>
  ({ stamp: { id: 'g', updatedAt: '2026-09-20T00:00:00.000Z' }, title: 'Welcome', body: bodyOf(slideIds, overrides, mode) });

const DERIVED = { kind: 'thumbnail', bytes: 1, hash: 'h', from: 'h' };

const LANGUAGES = [
  { stamp: { id: 'k1' }, key: 'ta', displayName: 'Tamil' },
  { stamp: { id: 'k2' }, key: 'ta-Latn', displayName: 'Tamil (Latin)' },
];

let routes: Record<string, () => ReturnType<typeof reply>>;
let calls: { key: string; body: unknown }[];

const signedIn = (permissions: string[]) => {
  session.value = {
    account: me,
    actor: 'account:a1', permissions, startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  calls = [];
  signedIn(['content.edit']);
  routes = {
    [`GET ${API.slideGroup('g')}`]: () => ok(group(['s1', 's2'])),
    [`GET ${API.contentLanguages}`]: () => ok(LANGUAGES),
    [`GET ${API.slideLayouts()}`]: () => ok([{ stamp: { id: 'L1' }, name: 'Lyrics' }, { stamp: { id: 'L2' }, name: 'Big' }]),
    [`GET ${API.mediaUpload}`]: () => ok([]),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`No reply for ${key}`);
    calls.push({ key, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return route();
  };
  setFetching(fetching);
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const sent = (key: string): unknown[] => calls.filter((call) => call.key === key).map((call) => call.body);

const renderEditor = async (): Promise<void> => {
  render(<><SlideGroupEditor groupId="g" /><SlideOverrides /></>);
  await settle();
};

describe('SlideGroupEditor', () => {
  it('overrides one slide layout, labels it, and clears it', async () => {
    routes[`PUT ${API.slideLayoutOverride('g', 's1')}`] = () => ok(group(['s1', 's2'], { s1: { layout: 'L2' } }));
    routes[`DELETE ${API.slideLayoutOverride('g', 's1')}`] = () => ok(group(['s1', 's2']));
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 1' }));
    await settle();
    expect(screen.getAllByText('Inherited from group')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'L2' } });
    await settle();
    expect(sent(`PUT ${API.slideLayoutOverride('g', 's1')}`)).toEqual([{ slideLayoutId: 'L2' }]);
    expect(screen.getByText('Overridden')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));
    await settle();
    expect(sent(`DELETE ${API.slideLayoutOverride('g', 's1')}`)).toHaveLength(1);
    expect(screen.queryByText('Overridden')).toBeNull();
  });

  it('overrides a background from the media library and clears it by choosing the group default', async () => {
    routes[`GET ${API.mediaUpload}`] = () => ok([
      { stamp: { id: 'x' }, manifest: { id: 'm1', bytes: 1, hash: 'h', type: 'image/png', processingState: 'ready', derivatives: [DERIVED] } },
    ]);
    routes[`PUT ${API.slideBackgroundOverride('g', 's2')}`] = () => ok(group(['s1', 's2'], { s2: { background: 'm1' } }));
    routes[`DELETE ${API.slideBackgroundOverride('g', 's2')}`] = () => ok(group(['s1', 's2']));
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 2' }));
    await settle();
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'm1' } });
    await settle();
    expect(sent(`PUT ${API.slideBackgroundOverride('g', 's2')}`)).toEqual([{ background: 'm1' }]);
    expect((screen.getByLabelText('Background') as HTMLSelectElement).value).toBe('m1');

    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '' } });
    await settle();
    expect(sent(`DELETE ${API.slideBackgroundOverride('g', 's2')}`)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 2' }));
    await settle();
    expect(activeSlide.value).toBeUndefined();
  });

  it('reorders slides and language blocks with one request each', async () => {
    routes[`PUT ${API.slideOrder('g')}`] = () => ok(group(['s2', 's1']));
    routes[`PUT ${API.languageBlockOrder('g', 's1')}`] = () => ok(group(['s2', 's1']));
    await renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Move Down' })[0] as HTMLButtonElement);
    await settle();
    expect(sent(`PUT ${API.slideOrder('g')}`)).toEqual([{ slideIds: ['s2', 's1'] }]);
    expect(screen.getAllByText(/^Label s/u).map((node) => node.textContent)).toEqual(['Label s2', 'Label s1']);

    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 2' }));
    await settle();
    const blocks = screen.getByRole('region', { name: 'Language blocks' });
    expect((screen.getByLabelText('Tamil text') as HTMLTextAreaElement).lang).toBe('ta');
    const up = Array.from(blocks.querySelectorAll('button')).filter((button) => button.textContent === 'Move Up');
    fireEvent.click(up[1] as HTMLButtonElement);
    await settle();
    expect(sent(`PUT ${API.languageBlockOrder('g', 's1')}`)).toEqual([{ blockIds: ['s1-lat', 's1-ta'] }]);
  });

  it('adds a slide through a whole-group save', async () => {
    routes[`PUT ${API.slideGroup('g')}`] = () => ok(group(['s1', 's2']));
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add Slide' }));
    await settle(799);
    expect(sent(`PUT ${API.slideGroup('g')}`)).toEqual([]);
    await settle(1);
    await settle();
    const saved = sent(`PUT ${API.slideGroup('g')}`) as SlideGroupBody[];
    expect(saved).toHaveLength(1);
    expect(saved[0]?.slides.map((slide) => slide.label)).toEqual(['Label s1', 'Label s2', 'Slide 3']);
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('adds a block and edits text, saving only once every block has text', async () => {
    routes[`PUT ${API.slideGroup('g')}`] = () => ok(group(['s1']));
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 1' }));
    await settle();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ta-Latn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Block' }));
    expect(screen.getByText('Give every slide a label and every block its text before it can save.')).toBeTruthy();
    await settle(1000);
    expect(sent(`PUT ${API.slideGroup('g')}`)).toEqual([]);

    const areas = screen.getAllByLabelText('Tamil (Latin) text');
    fireEvent.input(areas[1] as HTMLTextAreaElement, { target: { value: 'pudhiya' } });
    fireEvent.input(screen.getByLabelText('Slide label'), { target: { value: 'Opening' } });
    await settle(800);
    await settle();
    const saved = sent(`PUT ${API.slideGroup('g')}`) as SlideGroupBody[];
    expect(saved[0]?.slides[0]).toMatchObject({ label: 'Opening', languageBlocks: [{}, {}, { languageKey: 'ta-Latn', text: 'pudhiya' }] });
  });

  it('flushes unsaved text before a per-slide change, and shows a refused one', async () => {
    routes[`PUT ${API.slideGroup('g')}`] = () => ok(group(['s1', 's2']));
    routes[`POST ${API.slideDuplicate('g', 's1')}`] = () => reply(409, errorEnvelope('entity.state_conflict', 'No.', 'r'));
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 1' }));
    await settle();
    fireEvent.input(screen.getByLabelText('Tamil text'), { target: { value: 'மாற்றம்' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[0] as HTMLButtonElement);
    await settle();
    expect(calls.map((call) => call.key).slice(-2)).toEqual([`PUT ${API.slideGroup('g')}`, `POST ${API.slideDuplicate('g', 's1')}`]);
    expect(screen.getByText('entity.state_conflict')).toBeTruthy();
  });

  it('shows and hides slides and the whole group', async () => {
    routes[`PATCH ${API.slide('g', 's1')}`] = () => ok(group(['s1', 's2'], { s1: { enabled: false } }));
    routes[`PATCH ${API.slideGroupStatus('g')}`] = () => ok({ ...group(['s1', 's2']), body: { ...bodyOf(['s1', 's2']), enabled: false } });
    await renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0] as HTMLButtonElement);
    await settle();
    expect(sent(`PATCH ${API.slide('g', 's1')}`)).toEqual([{ enabled: false }]);
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show this group'));
    await settle();
    expect(sent(`PATCH ${API.slideGroupStatus('g')}`)).toEqual([{ enabled: false }]);
    expect((screen.getByLabelText('Show this group') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a generated group read-only apart from its per-slide operations', async () => {
    routes[`GET ${API.slideGroup('g')}`] = () => ok(group(['s1'], {}, 'generated'));
    routes[`POST ${API.languageBlockDuplicate('g', 's1', 's1-ta')}`] = () => ok(group(['s1'], {}, 'generated'));
    await renderEditor();
    expect(screen.getByText(/Generated from a song/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Slide' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 1' }));
    await settle();
    expect((screen.getByLabelText('Tamil text') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add Block' })).toBeNull();
    const blocks = screen.getByRole('region', { name: 'Language blocks' });
    const duplicate = Array.from(blocks.querySelectorAll('button')).find((button) => button.textContent === 'Duplicate');
    fireEvent.click(duplicate as HTMLButtonElement);
    await settle();
    expect(sent(`POST ${API.languageBlockDuplicate('g', 's1', 's1-ta')}`)).toHaveLength(1);
  });

  it('disables every change without content rights', async () => {
    signedIn([]);
    await renderEditor();
    expect((screen.getAllByRole('button', { name: 'Duplicate' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Show this group') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit slide 1' }));
    await settle();
    expect((screen.getByLabelText('Layout') as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows a group that cannot be read', async () => {
    routes[`GET ${API.slideGroup('g')}`] = () => reply(404, errorEnvelope('entity.not_found', 'Gone.', 'r'));
    await renderEditor();
    expect(screen.getByText('entity.not_found')).toBeTruthy();
  });

  it('shows an unreadable answer to a change', async () => {
    routes[`POST ${API.slideDuplicate('g', 's1')}`] = () => ok({ nope: true });
    routes[`PUT ${API.slideGroup('g')}`] = () => reply(403, errorEnvelope('auth.forbidden', 'No.', 'r'));
    await renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[0] as HTMLButtonElement);
    await settle();
    expect(screen.getByText('client.unreadable_response')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Slide' }));
    await settle(800);
    await settle();
    expect(screen.getByText('auth.forbidden')).toBeTruthy();
  });
});
