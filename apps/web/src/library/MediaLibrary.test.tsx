// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope, VALIDATION_FAILED } from '@holydeck/contracts/http';

import type { ApiResult, FetchLike, RequestInitLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { outputDefaults } from '../workspace/output-defaults.js';
import { MediaLibrary, readLibraryMedia } from './MediaLibrary.js';

const uploads = vi.hoisted(() => ({ answers: [] as ApiResult<unknown>[] }));
vi.mock('./upload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./upload.js')>()),
  uploadMedia: async (_file: File, onProgress: (sent: number, total: number) => void): Promise<ApiResult<unknown>> => {
    onProgress(1, 2);
    return uploads.answers.shift() ?? { ok: true, data: {}, requestId: 'r', version: undefined, dropped: undefined };
  },
}));

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const ok = (data: unknown) => reply(200, successEnvelope(data, 'r'));
const refused = (code: string): ApiResult<unknown> => ({ ok: false, code, message: code, requestId: 'r', fields: [] });

const HASH = `sha256:${'a'.repeat(64)}`;
const derivative = { kind: 'thumbnail', bytes: 2048, hash: HASH, from: HASH };
const record = (id: string, processingState: string, extra: Record<string, unknown> = {}) => ({
  stamp: { id, kind: 'mediaAsset', ...extra },
  manifest: { id, bytes: 5_242_880, hash: HASH, type: 'image/png', processingState, derivatives: processingState === 'ready' ? [derivative] : [] },
});

let calls: { key: string; init: RequestInitLike }[];
let routes: Record<string, ReturnType<typeof reply>>;

const signIn = (permissions: readonly string[]): void => {
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: [...permissions], startedAt: '2026-09-13T09:30:00.000Z',
    lastSeenAt: '2026-09-13T09:30:00.000Z', expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
};

beforeEach(() => {
  signIn(['media.manage', 'content.edit']);
  outputDefaults.value = { aspectRatio: '16:9', safeAreaMargins: { top: 0, right: 0, bottom: 0, left: 0, unit: 'percent' }, uploadLimitBytes: 1024 };
  uploads.answers = [];
  calls = [];
  routes = {
    [`GET ${API.mediaList()}`]: ok([record('queued.png', 'pending'), record('busy.png', 'processing'), record('done.png', 'ready'), record('bad.png', 'failed')]),
    [`GET ${API.mediaList(true)}`]: ok([record('done.png', 'ready', { archivedAt: '2026-09-20T00:00:00.000Z' })]),
    [`PATCH ${API.mediaStatus('done.png')}`]: ok(record('done.png', 'ready', { archivedAt: '2026-09-20T00:00:00.000Z' })),
    [`POST ${API.mediaRetry('bad.png')}`]: ok(record('bad.png', 'pending')),
  };
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const route = routes[key];
    if (route === undefined) throw new Error(`No reply for ${key}`);
    return route;
  };
  setFetching(fetching);
});

afterEach(() => {
  outputDefaults.value = undefined;
  vi.unstubAllGlobals();
});

const choose = (files: readonly File[]): void => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};

describe('MediaLibrary', () => {
  it('shows state as text for queued, processing, ready and failed', async () => {
    render(<MediaLibrary />);
    const list = await screen.findByRole('list', { name: 'Media' });
    for (const state of ['Queued', 'Processing', 'Ready', 'Failed']) expect(list.textContent).toContain(state);
    expect(list.textContent).toContain('5.0 MB');
  });

  it('shows a 413 as the reserve explanation with Review storage', async () => {
    uploads.answers = [refused('media.too_large')];
    render(<MediaLibrary />);
    await screen.findByRole('list', { name: 'Media' });
    choose([new File([new Uint8Array(10)], 'big.png', { type: 'image/png' })]);
    expect((await screen.findByRole('link', { name: 'Review storage' })).getAttribute('href')).toBe('/admin/storage');
    expect(screen.getByRole('alert').textContent).toContain('storage reserve');
  });

  it('checks size and type before sending, and explains other refusals', async () => {
    uploads.answers = [refused(VALIDATION_FAILED), refused('client.network_unreachable'), refused('media.odd')];
    render(<MediaLibrary />);
    await screen.findByRole('list', { name: 'Media' });
    choose([
      new File([new Uint8Array(2048)], 'huge.png', { type: 'image/png' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'odd.png', { type: 'image/png' }),
      new File(['x'], 'twice.png', { type: 'image/png' }),
      new File(['x'], 'third.png', { type: 'image/png' }),
    ]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('larger than the 1.0 KB upload limit');
    expect(alert.textContent?.match(/can’t be used/gu)).toHaveLength(2);
    expect(alert.textContent).toContain('twice.png: The server could not be reached.');
    expect(alert.textContent).toContain('third.png: Something went wrong (media.odd). Try again.');
  });

  it('refreshes the list after an upload and follows a drop', async () => {
    render(<MediaLibrary />);
    await screen.findByRole('list', { name: 'Media' });
    const zone = document.querySelector('.drop-zone') as HTMLElement;
    fireEvent.dragOver(zone);
    expect(zone.className).toContain('over');
    fireEvent.dragLeave(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'new.png', { type: 'image/png' })] } });
    await waitFor(() => expect(calls.filter((call) => call.key === `GET ${API.mediaList()}`)).toHaveLength(2));
  });

  it('archives with a confirmation and restores', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(<MediaLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /done\.png/u }));
    const pane = screen.getByRole('region', { name: 'done.png' });
    expect(pane.textContent).toContain('Not recorded');
    expect(pane.textContent).toContain('thumbnail (2.0 KB)');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(confirm).toHaveBeenCalledWith('Archive done.png? Services that already use it keep showing it.');
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(calls.find((call) => call.key.startsWith('PATCH'))?.init.body).toBe(JSON.stringify({ archived: true }));
    fireEvent.click(restore);
    await waitFor(() => expect(calls.filter((call) => call.key.startsWith('PATCH'))).toHaveLength(2));
    expect(calls.filter((call) => call.key.startsWith('PATCH'))[1]?.init.body).toBe(JSON.stringify({ archived: false }));
    fireEvent.click(screen.getByLabelText('Show archived'));
    await waitFor(() => expect(calls.some((call) => call.key === `GET ${API.mediaList(true)}`)).toBe(true));
  });

  it('keeps an unconfirmed archive, retries failed processing, and shows a refusal', async () => {
    vi.stubGlobal('confirm', () => false);
    render(<MediaLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: /done\.png/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(calls.some((call) => call.key.startsWith('PATCH'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /bad\.png/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }));
    await waitFor(() => expect(calls.some((call) => call.key === `POST ${API.mediaRetry('bad.png')}`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull());

    routes[`POST ${API.mediaRetry('bad.png')}`] = reply(409, errorEnvelope('entity.conflict', 'no', 'r'));
    fireEvent.click(await screen.findByRole('button', { name: /done\.png/u }));
    fireEvent.click(await screen.findByRole('button', { name: /bad\.png/u }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry processing' }));
    expect((await screen.findByRole('alert')).textContent).toContain('entity.conflict');
  });

  it('offers no upload or archive to a reader, and shows a list refusal with retry', async () => {
    signIn(['content.edit']);
    routes[`GET ${API.mediaList()}`] = reply(500, errorEnvelope('server.error', 'no', 'r'));
    render(<MediaLibrary />);
    expect(await screen.findByRole('button', { name: 'Try Again' })).toBeTruthy();
    expect(screen.queryByText('Upload Media')).toBeNull();
    routes[`GET ${API.mediaList()}`] = ok([record('bad.png', 'failed')]);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    fireEvent.click(await screen.findByRole('button', { name: /bad\.png/u }));
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
  });

  it('reads records, leaving out an unreadable manifest', () => {
    expect(readLibraryMedia([record('a', 'ready'), { manifest: {} }, 'x'])).toMatchObject({ ok: true, value: [{ id: 'a', archived: false }] });
    expect(readLibraryMedia({}).ok).toBe(false);
  });
});
