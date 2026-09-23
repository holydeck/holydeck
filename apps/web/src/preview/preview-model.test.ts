// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../api.js';
import { setFetching } from '../request.js';
import { outputDefaults } from '../workspace/output-defaults.js';
import { placeholderRatio, PreviewError, previewSourceFor } from './preview-model.js';

const intrinsicSizeOf = vi.hoisted(() => vi.fn());
vi.mock('./media-size.js', () => ({ intrinsicSizeOf }));

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const fetchingWith = (map: Record<string, ReturnType<typeof reply>>): FetchLike => async (url, init) => {
  const response = map[`${init.method ?? 'GET'} ${url}`];
  if (response === undefined) throw new Error(`No reply for ${url}`);
  return response;
};

const media = (content?: ServiceItem['content']): ServiceItem => ({ id: 'i1', kind: 'media', title: 'Clip', enabled: true, content });
const manifest = (type: string) => reply(200, successEnvelope({ stamp: {}, manifest: { id: 'm1', type } }, 'r'));

beforeEach(() => {
  intrinsicSizeOf.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof PreviewError ? error.code : 'not-a-preview-error';
  }
}

describe('previewSourceFor', () => {
  it('reads a media item kind from its manifest and its size from the media itself', async () => {
    setFetching(fetchingWith({ 'GET /api/v1/media/m1': manifest('video/mp4') }));
    intrinsicSizeOf.mockResolvedValue({ width: 1280, height: 720 });

    await expect(previewSourceFor(media({ id: 'm1', revision: 1, hash: undefined }))).resolves.toEqual({
      kind: 'media', mediaId: 'm1', mediaKind: 'video', intrinsicSize: { width: 1280, height: 720 },
    });
    expect(intrinsicSizeOf).toHaveBeenCalledWith('m1', 'video');
  });

  it('reads an image manifest as a picture', async () => {
    setFetching(fetchingWith({ 'GET /api/v1/media/m1': manifest('image/png') }));
    intrinsicSizeOf.mockResolvedValue({ width: 10, height: 10 });

    await expect(previewSourceFor(media({ id: 'm1', revision: 1, hash: undefined }))).resolves.toMatchObject({ mediaKind: 'image' });
  });

  it('refuses a media item without media, a font, an unreachable size and a refused manifest', async () => {
    expect(await codeOf(previewSourceFor(media()))).toBe('preview.media_missing');

    setFetching(fetchingWith({ 'GET /api/v1/media/m1': manifest('font/woff2') }));
    expect(await codeOf(previewSourceFor(media({ id: 'm1', revision: 1, hash: undefined })))).toBe('preview.media_unsupported');

    setFetching(fetchingWith({ 'GET /api/v1/media/m1': manifest('image/png') }));
    intrinsicSizeOf.mockRejectedValue(new Error('no poster'));
    expect(await codeOf(previewSourceFor(media({ id: 'm1', revision: 1, hash: undefined })))).toBe('media.derivative_missing');

    setFetching(fetchingWith({ 'GET /api/v1/media/m1': reply(404, errorEnvelope('media.not_found', 'Gone.', 'r')) }));
    expect(await codeOf(previewSourceFor(media({ id: 'm1', revision: 1, hash: undefined })))).toBe('media.not_found');
  });

  it('answers later for a reading without a passage, and an unreadable verses answer is an error', async () => {
    const reading: ServiceItem = { id: 'i2', kind: 'reading', title: 'Reading', enabled: true, content: undefined };
    await expect(previewSourceFor(reading)).resolves.toBe('later');

    setFetching(async () => reply(200, successEnvelope({ verses: 'nope' }, 'r')));
    const withBody: ServiceItem = {
      ...reading, body: { kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16' },
    };
    expect(await codeOf(previewSourceFor(withBody))).toBe('client.unreadable_response');
  });

  it('draws an empty custom slide when the item carries no body yet', async () => {
    const blank: ServiceItem = { id: 'i3', kind: 'custom-slide', title: 'Blank', enabled: true, content: undefined };
    await expect(previewSourceFor(blank)).resolves.toEqual({ kind: 'custom-slide', body: { kind: 'custom-slide', boxes: [] } });
  });

  describe('a song or slide group item', () => {
    const groupBody = (slideLayoutRevision?: number) => ({
      mode: 'generated', enabled: true, slideLayoutId: 'L1',
      ...(slideLayoutRevision === undefined ? {} : { generatedFrom: { songId: 'song1', songRevision: 2, slideLayoutId: 'L1', slideLayoutRevision } }),
      slides: [{ id: 's1', enabled: true, label: 'Verse 1', languageBlocks: [{ id: 'b1', languageKey: 'ta', text: 'கர்த்தர்' }] }],
    });
    const record = (title: string, body: unknown) => ({ stamp: { id: 'g1', updatedAt: '2026-09-20T00:00:00.000Z' }, title, body });
    const song = (content?: ServiceItem['content']): ServiceItem => ({ id: 'i4', kind: 'song', title: 'Song', enabled: true, content });
    const boxes = [{
      id: 'lyric', kind: 'text', importance: 'required', frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
      binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' },
      style: { fontFamily: 'Inter', fontWeight: 600, sizeRatio: 0.08, lineHeight: 1.25, align: 'center', verticalAlign: 'center' },
    }];
    const layout = reply(200, successEnvelope({ stamp: {}, name: 'Lyrics', revision: 3, body: { boxes } }, 'r'));

    it('draws the pinned group revision with the Layout revision it was generated with', async () => {
      setFetching(fetchingWith({
        'GET /api/v1/slide-groups/g1/history': reply(200, successEnvelope([record('Old', groupBody(3)), record('New', { ...groupBody(3), slides: [] })], 'r')),
        'GET /api/v1/slide-layouts/L1?revision=3': layout,
      }));
      await expect(previewSourceFor(song({ id: 'g1', revision: 1, hash: undefined }))).resolves.toEqual({
        kind: 'slide-group',
        group: { id: 'g1', revision: 1, slides: [{ id: 's1', enabled: true, blocks: [{ language: 'ta', text: 'கர்த்தர்' }] }] },
        layout: { boxes },
      });
    });

    it("uses a hand-made group's newest Layout, and refuses a missing group or an unreadable Layout", async () => {
      const slideGroup: ServiceItem = { ...song({ id: 'g1', revision: 1, hash: undefined }), kind: 'slide-group' };
      setFetching(fetchingWith({
        'GET /api/v1/slide-groups/g1/history': reply(200, successEnvelope([record('Hand', groupBody())], 'r')),
        'GET /api/v1/slide-layouts/L1': layout,
      }));
      await expect(previewSourceFor(slideGroup)).resolves.toMatchObject({ kind: 'slide-group', layout: { boxes } });

      expect(await codeOf(previewSourceFor(song()))).toBe('preview.group_missing');
      expect(await codeOf(previewSourceFor(song({ id: 'g1', revision: 5, hash: undefined })))).toBe('preview.group_missing');

      setFetching(fetchingWith({
        'GET /api/v1/slide-groups/g1/history': reply(200, successEnvelope([record('Hand', groupBody())], 'r')),
        'GET /api/v1/slide-layouts/L1': reply(200, successEnvelope({ body: { boxes: 'no' } }, 'r')),
      }));
      expect(await codeOf(previewSourceFor(slideGroup))).toBe('client.unreadable_response');
    });
  });
});

describe('placeholderRatio', () => {
  it('uses the service ratio once defaults are known, else 16 / 9', () => {
    const view = { id: 's1', title: 'S', date: '2026-09-27', site: 'Main', state: 'upcoming', sections: [], revision: 'r', output: { aspectRatio: '4:3' } } as const;
    outputDefaults.value = undefined;
    expect(placeholderRatio(view)).toBe('16 / 9');
    outputDefaults.value = { aspectRatio: '16:9', safeAreaMargins: { unit: 'percent', top: 5, right: 5, bottom: 5, left: 5 }, uploadLimitBytes: 1 };
    expect(placeholderRatio(view)).toBe('4 / 3');
    outputDefaults.value = undefined;
  });
});
