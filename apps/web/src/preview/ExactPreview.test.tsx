// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, saveState, service } from '../state/workspace-store.js';
import { outputDefaults } from '../workspace/output-defaults.js';
import type { ServiceView } from '../workspace/service-data.js';
import { ExactPreview } from './ExactPreview.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const signedIn = (): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions: ['services.manage', 'content.edit'],
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const DEFAULTS = {
  aspectRatio: '16:9',
  safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  uploadLimitBytes: 1_073_741_824,
};

// A text box across the whole top edge: outside the 5% safe area, and required, so it blocks readiness.
const welcome: ServiceItem = {
  id: 'i1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined,
  body: {
    kind: 'custom-slide',
    boxes: [{
      id: 't1', kind: 'text', frame: { x: 0, y: 0, width: 1, height: 0.2 }, layer: 0, text: 'Welcome',
      style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
    }],
  },
};

const reading: ServiceItem = {
  id: 'i2', kind: 'reading', title: 'John 3', enabled: true, content: undefined,
  body: { kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16' },
};

const song: ServiceItem = { id: 'i3', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id: 'g1', revision: 1, hash: undefined } };
const sermon: ServiceItem = { id: 'i4', kind: 'sermon', title: 'Grace', enabled: true, content: { id: 'sermon1', revision: 1, hash: undefined } };
const GROUP = {
  stamp: { id: 'g1', updatedAt: 'u' }, title: 'Amazing Grace',
  body: {
    mode: 'custom', enabled: true, slideLayoutId: 'L1',
    slides: [{ id: 's1', enabled: true, label: 'Verse 1', languageBlocks: [{ id: 'b1', languageKey: 'ta-Latn', text: 'Amazing grace' }] }],
  },
};
const LAYOUT = {
  stamp: { id: 'L1' }, name: 'Lyrics', revision: 2,
  body: {
    boxes: [{
      id: 'lyric', kind: 'text', importance: 'required', frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
      binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta-Latn' },
      style: { fontFamily: 'Inter', fontWeight: 600, sizeRatio: 0.08, lineHeight: 1.25, align: 'center', verticalAlign: 'center' },
    }],
  },
};

const viewWith = (items: ServiceItem[]): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'sec1', name: 'Worship', items }],
});

const versesBody = {
  verses: { verses: { '16': 'For God so loved the world' }, citation: 'John 3:16', revision: 1, fetchedAt: '2026-09-23T10:00:00.000Z', source: 'cache' },
};

type Reply = ReturnType<typeof reply>;
const fakeFetch = (map: Record<string, Reply | Reply[]>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const entry = map[key];
    const response = Array.isArray(entry) ? entry.shift() : entry;
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  outputDefaults.value = undefined;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExactPreview', () => {
  it('draws a custom slide with the safe-area legend and a blocking finding', async () => {
    service.value = viewWith([welcome]);
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')) }));

    render(<ExactPreview itemId="i1" />);

    expect(await screen.findByRole('img', { name: 'Preview of Welcome' })).toBeTruthy();
    expect(screen.getByText('Dashed line: safe area')).toBeTruthy();
    const blocker = screen.getByText('Blocks readiness').closest('li');
    expect(blocker?.className).toBe('preview-finding-blocker');
    expect(blocker?.textContent).toContain('Content reaches outside the safe area.');
  });

  it('shows the failure with its code, and Try Again draws the reading', async () => {
    service.value = viewWith([reading]);
    const versesKey = `GET ${API.verses('KJV', 'JHN', 3, '16')}`;
    setFetching(fakeFetch({
      'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')),
      [versesKey]: [
        reply(404, errorEnvelope('corpus.passage_missing', 'No such passage.', 'r-e')),
        reply(200, successEnvelope(versesBody, 'r-v')),
      ],
    }));

    render(<ExactPreview itemId="i2" />);

    expect(await screen.findByText("We couldn't draw this slide.")).toBeTruthy();
    expect(screen.getByText('corpus.passage_missing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('img', { name: 'Preview of John 3' })).toBeTruthy();
  });

  it('changing the target re-prepares without any new request', async () => {
    service.value = viewWith([welcome]);
    const calls: string[] = [];
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')) }, calls));

    render(<ExactPreview itemId="i1" />);
    await screen.findByRole('img', { name: 'Preview of Welcome' });
    const before = calls.length;

    fireEvent.click(screen.getByRole('radio', { name: 'Stage' }));
    await screen.findByRole('img', { name: 'Preview of Welcome' });
    expect((screen.getByRole('radio', { name: 'Stage' }) as HTMLInputElement).checked).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('draws a song item from its pinned slide group and that group\'s Slide Layout', async () => {
    service.value = viewWith([song]);
    setFetching(fakeFetch({
      'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')),
      [`GET ${API.contentHistory('slideGroup', 'g1')}`]: reply(200, successEnvelope([GROUP], 'r-h')),
      [`GET ${API.slideLayout('L1')}`]: reply(200, successEnvelope(LAYOUT, 'r-l')),
    }));

    render(<ExactPreview itemId="i3" />);

    expect(await screen.findByRole('img', { name: 'Preview of Amazing Grace' })).toBeTruthy();
  });

  it('says a later update brings previews for kinds it does not draw yet', async () => {
    service.value = viewWith([sermon]);
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')) }));

    render(<ExactPreview itemId="i4" />);

    expect(await screen.findByText('A preview for this kind of item appears in a later update.')).toBeTruthy();
  });

  it('shows the loading state first, and keeps the last render while offline', async () => {
    service.value = viewWith([welcome]);
    const calls: string[] = [];
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS, 'r-d')) }, calls));

    render(<ExactPreview itemId="i1" />);
    expect(screen.getByText('Drawing the slide…')).toBeTruthy();
    await screen.findByRole('img', { name: 'Preview of Welcome' });

    saveState.value = 'offline';
    await waitFor(() => expect(screen.getByRole('img', { name: 'Preview of Welcome' })).toBeTruthy());
    expect(screen.queryByText('Drawing the slide…')).toBeNull();
  });

  it('renders nothing for an item that is not in the service', () => {
    service.value = viewWith([]);
    const { container } = render(<ExactPreview itemId="gone" />);
    expect(container.innerHTML).toBe('');
  });
});
