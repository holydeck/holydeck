// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../../api.js';
import { API } from '../../api-routes.js';
import { session } from '../../app-state.js';
import { setFetching } from '../../request.js';
import { resetWorkspace, selection, service } from '../../state/workspace-store.js';
import { mediaAddress, MediaTab, readMediaRows } from './MediaTab.js';

const intrinsic = vi.hoisted(() => vi.fn(async () => ({ width: 1920, height: 1080 })));
vi.mock('../../preview/media-size.js', () => ({ intrinsicSizeOf: intrinsic }));

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));

const HEX = 'ab'.repeat(32);
const DERIVED = { kind: 'thumbnail', bytes: 1, hash: 'h', from: 'h' };
const manifest = (id: string, type: string, processingState: string, hash = `sha256:${HEX}`) =>
  ({ stamp: { id }, manifest: { id, bytes: 1, hash, type, processingState, derivatives: processingState === 'ready' ? [DERIVED] : [] } });
const MEDIA = [
  manifest('m1', 'image/png', 'ready'),
  manifest('m2', 'video/mp4', 'processing'),
  manifest('m3', 'image/png', 'pending'),
  manifest('m4', 'image/png', 'failed'),
  manifest('clip', 'video/mp4', 'ready', 'md5:x'),
  { stamp: { id: 'broken' }, manifest: { id: 'broken' } },
];

const LIST = `GET ${API.mediaList()}`;
const INSERT = `POST ${API.sectionItems('s1', 'main')}`;
let routes: Record<string, ReturnType<typeof reply> | ReturnType<typeof reply>[]>;
let bodies: Map<string, unknown>;

beforeEach(() => {
  resetWorkspace();
  intrinsic.mockClear();
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage', 'content.edit'], startedAt: '2026-09-13T09:30:00.000Z',
    lastSeenAt: '2026-09-13T09:30:00.000Z', expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  const view = { id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming' as const, revision: 'r0', sections: [{ id: 'main', name: 'Main', items: [] }] };
  service.value = view;
  bodies = new Map();
  routes = {
    [LIST]: ok(MEDIA),
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

describe('MediaTab', () => {
  it('lists processing media as text and only lets ready media be inserted', async () => {
    render(<MediaTab />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    const processing = await screen.findByRole('option', { name: /m2.*Processing/u });
    expect(processing.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /m3.*Queued/u }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /m4.*Failed/u }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('option', { name: /broken/u })).toBeNull();
    expect(processing.getAttribute('aria-describedby')).toBe('media-not-ready-insert');
    expect(screen.getByText(/Only ready images and videos can be added/u)).toBeTruthy();
    const ready = screen.getByRole('option', { name: /m1.*Ready/u });
    expect(ready.querySelector('img')?.getAttribute('src')).toBe(API.mediaDerivative('m1', 'thumbnail'));

    const insert = screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement;
    fireEvent.click(processing);
    expect(insert.disabled).toBe(true);
    fireEvent.keyDown(ready, { key: 'a' });
    expect(insert.disabled).toBe(true);
    fireEvent.keyDown(ready, { key: 'Enter' });
    expect(ready.getAttribute('aria-selected')).toBe('true');
    expect(insert.disabled).toBe(false);

    fireEvent.click(insert);
    await waitFor(() => expect(selection.value.itemId).toBeDefined());
    expect(bodies.get(INSERT)).toMatchObject({ kind: 'media', title: 'm1', content: { id: 'm1', revision: 1, hash: `sha256-${HEX}` } });
  });

  it('narrows by the search, and hands a picked asset with its size to the canvas', async () => {
    const onPick = vi.fn();
    const { rerender } = render(<MediaTab mode="pick" query="clip" onPick={onPick} />);
    const clip = await screen.findByRole('option', { name: /clip.*Ready/u });
    expect(screen.queryByRole('option', { name: /m1/u })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
    fireEvent.click(clip);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ mediaId: 'clip', mediaKind: 'video', intrinsicSize: { width: 1920, height: 1080 } }));

    intrinsic.mockRejectedValueOnce(new Error('broken'));
    fireEvent.click(clip);
    expect(await screen.findByText('media.unreadable')).toBeTruthy();

    rerender(<MediaTab mode="pick" query="nothing" onPick={onPick} />);
    expect(screen.getByText('No matching content')).toBeTruthy();
  });

  it('shows an empty library, a refusal with Try Again, and an unreadable list', async () => {
    routes[LIST] = [reply(403, errorEnvelope('auth.forbidden', 'No.', 'r')), ok([]), ok({ not: 'a list' })];
    const { unmount } = render(<MediaTab />);
    expect(await screen.findByText('auth.forbidden')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Upload media in the media library to add it here.')).toBeTruthy();
    unmount();
    render(<MediaTab />);
    expect(await screen.findByText('client.unreadable_response')).toBeTruthy();
  });
});

describe('media helpers', () => {
  it('reads media rows and pins only a sha256 address', () => {
    expect(readMediaRows({}).ok).toBe(false);
    expect(readMediaRows([manifest('doc', 'application/pdf', 'ready')])).toEqual({
      ok: true, value: [{ id: 'doc', type: 'application/pdf', hash: `sha256:${HEX}`, state: 'ready' }],
    });
    expect(mediaAddress(`sha256:${HEX}`)).toBe(`sha256-${HEX}`);
    expect(mediaAddress('md5:x')).toBeUndefined();
  });
});
