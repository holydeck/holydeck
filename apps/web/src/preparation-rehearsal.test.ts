import { createHash, webcrypto } from 'node:crypto';

import { prepareRenderModel } from '@holydeck/renderer/render-model';
import { frameBytes, renderPrepared } from '@holydeck/renderer/renderer';
import { describe, expect, it } from 'vitest';

import { rehearsePreparation } from './preparation-rehearsal.js';

import type { TextMeasurer } from '@holydeck/renderer/measure';
import type { RenderModelInput, SlideInput } from '@holydeck/renderer/render-model';
import type { PreparationBodyLike, PreparationCacheLike, PreparationSubtleLike, PinnedEntry } from './preparation-cache.js';
import type { RehearsalDocument } from './preparation-rehearsal.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/** The digest form a manifest records, computed by a different implementation than the one under test:
 *  fixtures use Node's `createHash`, the module verifies with WebCrypto. */
const recordedDigest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ---------------------------------------------------------------------------------------------------
// The browser capabilities, injected
// ---------------------------------------------------------------------------------------------------

const subtle: PreparationSubtleLike = webcrypto.subtle;

/**
 * The measurer the snapshot was pinned with: a fixed advance width per character, so a suite about
 * rehearsing never depends on a real font being installed. `measure.ts`'s own suite drives headless
 * Chrome; this one only needs two measurers that disagree.
 */
const onlineMeasurer: TextMeasurer = {
  measure: (requests) =>
    Promise.resolve(
      requests.map((request) => ({
        widthPx: request.text.length * request.fontSizePx * 0.5,
        heightPx: request.fontSizePx * request.lineHeight,
        lineCount: 1,
      })),
    ),
  close: () => Promise.resolve(),
};

/** The same browser with the pinned font missing: the fallback face wraps where the real one did not. */
const fallbackFontMeasurer: TextMeasurer = {
  measure: (requests) =>
    Promise.resolve(
      requests.map((request) => ({
        widthPx: request.text.length * request.fontSizePx * 0.5,
        heightPx: request.fontSizePx * request.lineHeight * 2,
        lineCount: 2,
      })),
    ),
  close: () => Promise.resolve(),
};

/** A browser that can still hash the cache's bytes and not the frames rehearsing produces. Only a
 *  rendered frame carries a readiness grade, so that is what this refuses. */
const noFrameDigest: PreparationSubtleLike = {
  digest: async (algorithm, data) => {
    if (new TextDecoder().decode(data).includes('"readiness"')) {
      throw new Error('SubtleCrypto gave out under memory pressure');
    }
    return webcrypto.subtle.digest(algorithm, data);
  },
};

interface FakeCache {
  readonly cache: PreparationCacheLike;
  readonly stored: Map<string, Uint8Array>;
  /** Every url read, in order, so a document read twice is visible as two entries. */
  readonly reads: string[];
}

const fakeCache = (
  seed: ReadonlyMap<string, Uint8Array>,
  options: {
    /** A browser that evicts an entry after it has been read this many times — the eviction that lands
     *  between the completeness check and the rehearsal that follows it. */
    readonly evictAfter?: { readonly url: string; readonly reads: number };
  } = {},
): FakeCache => {
  const stored = new Map<string, Uint8Array>(seed);
  const reads: string[] = [];
  const body = (bytes: Uint8Array): PreparationBodyLike => ({ arrayBuffer: async () => toArrayBuffer(bytes) });
  return {
    stored,
    reads,
    cache: {
      match: async (url) => {
        reads.push(url);
        const evict = options.evictAfter;
        if (evict !== undefined && evict.url === url && reads.filter((read) => read === url).length > evict.reads) {
          stored.delete(url);
        }
        const held = stored.get(url);
        return held === undefined ? undefined : body(held);
      },
      // A rehearsal reads the cache and changes nothing in it. Either of these being reached is the
      // defect, so they are failures rather than stubs.
      put: async () => {
        throw new Error('a rehearsal must never write to the cache');
      },
      delete: async () => {
        throw new Error('a rehearsal must never delete from the cache');
      },
    },
  };
};

// ---------------------------------------------------------------------------------------------------
// One Sunday's pinned snapshot: two render-model documents and the picture behind them
// ---------------------------------------------------------------------------------------------------

const textSlide = (id: string, text: string): SlideInput => ({
  id,
  boxes: [
    {
      id: `${id}-lyric`,
      kind: 'text',
      text,
      frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.4 },
      font: { family: 'Inter', weight: 600, sizeRatio: 0.08, lineHeight: 1.2 },
      importance: 'required',
    },
  ],
});

const SONG_MODEL: RenderModelInput = {
  id: 'song-grace',
  outputType: 'main',
  slides: [
    textSlide('grace-verse-1', 'Amazing grace, how sweet the sound'),
    textSlide('grace-verse-2', 'That saved a wretch like me'),
    textSlide('grace-chorus', 'I once was lost, but now am found'),
  ],
};

const READING_MODEL: RenderModelInput = {
  id: 'reading-psalm-23',
  outputType: 'main',
  slides: [textSlide('psalm-23-1', 'The Lord is my shepherd; I shall not want')],
};

const SONG_URL = '/snapshots/svc-2026-09-21/song-grace.json';
const READING_URL = '/snapshots/svc-2026-09-21/reading-psalm-23.json';
const BACKGROUND_URL = '/media/sermon-background.png';

const BACKGROUND_BODY = Uint8Array.from({ length: 512 }, (_, index) => index % 251);

const jsonOf = (model: RenderModelInput): Uint8Array => bytesOf(JSON.stringify(model));

/** What rendering this model came to, the way the pinning build recorded it. */
const frameDigestOf = async (model: RenderModelInput, measurer: TextMeasurer = onlineMeasurer): Promise<string> => {
  const prepared = await prepareRenderModel({ model, measurer });
  return recordedDigest(frameBytes(renderPrepared(prepared)));
};

const documentEntry = async (
  id: string,
  url: string,
  model: RenderModelInput,
  measurer?: TextMeasurer,
): Promise<RehearsalDocument> => {
  const body = jsonOf(model);
  return {
    id,
    url,
    necessity: 'mandatory',
    hash: recordedDigest(body),
    bytes: body.length,
    frameHash: await frameDigestOf(model, measurer),
  };
};

const BACKGROUND_ENTRY: PinnedEntry = {
  id: 'sermon-background',
  url: BACKGROUND_URL,
  hash: recordedDigest(BACKGROUND_BODY),
  necessity: 'mandatory',
  bytes: BACKGROUND_BODY.length,
};

interface Snapshot {
  readonly pinned: readonly PinnedEntry[];
  readonly seed: Map<string, Uint8Array>;
}

const snapshot = async (): Promise<Snapshot> => ({
  pinned: [
    await documentEntry('song-grace', SONG_URL, SONG_MODEL),
    await documentEntry('reading-psalm-23', READING_URL, READING_MODEL),
    BACKGROUND_ENTRY,
  ],
  seed: new Map([
    [SONG_URL, jsonOf(SONG_MODEL)],
    [READING_URL, jsonOf(READING_MODEL)],
    [BACKGROUND_URL, BACKGROUND_BODY],
  ]),
});

/** A pinned entry with one field replaced, for a snapshot that is wrong in exactly one way. */
const replacing = (pinned: readonly PinnedEntry[], id: string, patch: Partial<RehearsalDocument>): PinnedEntry[] =>
  pinned.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));

// ---------------------------------------------------------------------------------------------------
// Rehearsing a cached snapshot slide by slide
// ---------------------------------------------------------------------------------------------------

describe('rehearsing a cached snapshot slide by slide', () => {
  it('runs every slide in the snapshot through the renderer and reports it rehearsed', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('rehearsed');
    expect(report.blockers).toEqual([]);
    // Every slide in the snapshot, in presentation order — not a sample of them, and not a count.
    expect(report.rehearsedSlideIds).toEqual([
      'grace-verse-1',
      'grace-verse-2',
      'grace-chorus',
      'psalm-23-1',
    ]);
    expect(report.documents.map((document) => document.state)).toEqual(['rehearsed', 'rehearsed']);
    expect(report.documents[0]).toMatchObject({
      documentId: 'song-grace',
      slideIds: ['grace-verse-1', 'grace-verse-2', 'grace-chorus'],
      findings: [],
    });
    expect(report.documents[0]?.frameHash).toBe(await frameDigestOf(SONG_MODEL));
  });

  it('renders from the cache, with nothing to fetch with and nothing written back', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);

    // There is no `fetch` in the clients this takes: a rehearsal that could reach a server would prove
    // the server still answers rather than that the cache still renders. The fixture's `put` and
    // `delete` throw, so a write would fail this rather than pass it quietly.
    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('rehearsed');
    expect(cache.reads).toContain(SONG_URL);
    expect(cache.reads).toContain(READING_URL);
    // Read twice each: once to prove the cache holds what the manifest pinned, once to render from.
    expect(cache.reads.filter((read) => read === SONG_URL)).toHaveLength(2);
    expect(cache.stored.size).toBe(3);
  });

  it('rehearses the pinned documents and never the assets beside them', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    // The picture is pinned, cached and verified, and is not a render model: it is checked into the
    // cache and never handed to the renderer.
    expect(report.documents.map((document) => document.documentId)).toEqual(['song-grace', 'reading-psalm-23']);
    expect(cache.reads.filter((read) => read === BACKGROUND_URL)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Refusing to rehearse a cache that is not complete
// ---------------------------------------------------------------------------------------------------

describe('refusing to rehearse a cache that is not complete', () => {
  it('blocks with the pinned ids still missing and rehearses nothing', async () => {
    const { pinned, seed } = await snapshot();
    seed.delete(BACKGROUND_URL);
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    // Rehearsing a half-cached snapshot proves nothing about presenting it offline, so nothing is
    // rendered at all and the answer names what is still missing.
    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([{ code: 'cache.incomplete', pendingAssetIds: ['sermon-background'] }]);
    expect(report.documents).toEqual([]);
    expect(report.rehearsedSlideIds).toEqual([]);
  });

  it('blocks when a cached document is not the bytes the manifest pinned', async () => {
    const { pinned, seed } = await snapshot();
    seed.set(SONG_URL, bytesOf('this file did not finish downloading'));
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([{ code: 'cache.incomplete', pendingAssetIds: ['song-grace'] }]);
  });

  it('never reports a snapshot rehearsed when there was nothing to rehearse', async () => {
    const cache = fakeCache(new Map([[BACKGROUND_URL, BACKGROUND_BODY]]));

    const report = await rehearsePreparation([BACKGROUND_ENTRY], {
      cache: cache.cache,
      subtle,
      measurer: onlineMeasurer,
    });

    // A completely cached snapshot with no render model in it has not been rehearsed; it has been
    // skipped, and a skipped rehearsal must never read as a passed one.
    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([{ code: 'snapshot.noDocuments' }]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Comparing the rehearsal against the online render
// ---------------------------------------------------------------------------------------------------

describe('comparing the rehearsal against the online render', () => {
  it('accepts either recorded digest form for the frame the online render produced', async () => {
    const { pinned, seed } = await snapshot();
    // Revisions address a body as `sha256-<hex>` and the media manifest records `sha256:<hex>`; both are
    // the same fact about the same frame.
    const dashed = replacing(pinned, 'song-grace', {
      frameHash: (await frameDigestOf(SONG_MODEL)).replace(':', '-').toUpperCase().replace('SHA256', 'sha256'),
    });
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(dashed, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('rehearsed');
  });

  it('blocks a document the manifest recorded no usable frame digest for, without rendering it', async () => {
    const { pinned, seed } = await snapshot();
    const unusable = replacing(pinned, 'reading-psalm-23', { frameHash: 'md5-0123456789abcdef' });
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(unusable, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    // Nothing is rendered for a document whose parity could never be checked once it was: the manifest
    // is the repair, not the renderer.
    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([{ code: 'document.frameHashUnknown', documentId: 'reading-psalm-23' }]);
    expect(report.documents[1]).toEqual({
      documentId: 'reading-psalm-23',
      state: 'failed',
      slideIds: [],
      findings: [],
      blocker: { code: 'document.frameHashUnknown', documentId: 'reading-psalm-23' },
    });
    expect(report.rehearsedSlideIds).toEqual(['grace-verse-1', 'grace-verse-2', 'grace-chorus']);
  });

  it('blocks when this browser cannot digest the frame it rendered', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);

    const report = await rehearsePreparation(pinned, {
      cache: cache.cache,
      subtle: noFrameDigest,
      measurer: onlineMeasurer,
    });

    // Unverifiable is not the same as diverged, and a browser that cannot prove parity has not proved it.
    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([
      { code: 'render.unverifiable', documentId: 'song-grace' },
      { code: 'render.unverifiable', documentId: 'reading-psalm-23' },
    ]);
    expect(report.documents[0]?.frameHash).toBeUndefined();
    // The slides were rendered; only the comparison could not be made.
    expect(report.documents[0]?.slideIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------
// Failure injection: the local render does not reproduce the online one (specification 14.3)
// ---------------------------------------------------------------------------------------------------

describe('failure injection: a rehearsal that does not reproduce the online render', () => {
  it('blocks offline readiness when the local render diverges from the online one', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);

    // The injection: this browser is missing the font the snapshot was pinned with, so the fallback face
    // wraps a line the real one did not. Every byte of the cache is exactly what the manifest pinned —
    // only rendering it here comes out different, which is the whole reason a rehearsal happens locally.
    const report = await rehearsePreparation(pinned, {
      cache: cache.cache,
      subtle,
      measurer: fallbackFontMeasurer,
    });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([
      {
        code: 'render.diverged',
        documentId: 'song-grace',
        recordedFrameHash: await frameDigestOf(SONG_MODEL),
        renderedFrameHash: await frameDigestOf(SONG_MODEL, fallbackFontMeasurer),
      },
      {
        code: 'render.diverged',
        documentId: 'reading-psalm-23',
        recordedFrameHash: await frameDigestOf(READING_MODEL),
        renderedFrameHash: await frameDigestOf(READING_MODEL, fallbackFontMeasurer),
      },
    ]);
    expect(report.documents.map((document) => document.state)).toEqual(['failed', 'failed']);
    expect(report.rehearsedSlideIds).toEqual([]);
  });

  it('rehearses the same snapshot once the divergence is gone', async () => {
    const { pinned, seed } = await snapshot();

    const diverged = await rehearsePreparation(pinned, {
      cache: fakeCache(seed).cache,
      subtle,
      measurer: fallbackFontMeasurer,
    });
    const repaired = await rehearsePreparation(pinned, {
      cache: fakeCache(seed).cache,
      subtle,
      measurer: onlineMeasurer,
    });

    // The same cache, the same manifest, the same slides: only the browser rendering them changed, and
    // that is the only thing the parity check is grading.
    expect(diverged.kind).toBe('blocked');
    expect(repaired.kind).toBe('rehearsed');
  });
});

// ---------------------------------------------------------------------------------------------------
// Failure injection: a slide the rehearsal cannot render (specification 14.3)
// ---------------------------------------------------------------------------------------------------

describe('failure injection: a slide the rehearsal cannot render', () => {
  it('blocks when the cache loses a document between the completeness check and the rehearsal', async () => {
    const { pinned, seed } = await snapshot();
    // The injection: the browser evicts this entry after the plan has verified it and before the
    // rehearsal reads it to render from. The second read is the one that matters — it is the copy a
    // Sunday morning gets.
    const cache = fakeCache(seed, { evictAfter: { url: READING_URL, reads: 1 } });

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([{ code: 'document.notCached', documentId: 'reading-psalm-23' }]);
    expect(report.rehearsedSlideIds).toEqual(['grace-verse-1', 'grace-verse-2', 'grace-chorus']);
  });

  it('blocks when the cached document is not a render model at all', async () => {
    const wrongBody = bytesOf('{"snapshot":"svc-2026-09-21","pins":{"service":"svc#3"}}');
    const song = await documentEntry('song-grace', SONG_URL, SONG_MODEL);
    // The manifest pinned the digest of these bytes, so the cache holds exactly what was pinned — and
    // what was pinned is not a render model. That is a defect in whatever produced the manifest.
    const pinned: readonly PinnedEntry[] = [{ ...song, hash: recordedDigest(wrongBody), bytes: wrongBody.length }];
    const cache = fakeCache(new Map([[SONG_URL, wrongBody]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([
      { code: 'document.unreadable', documentId: 'song-grace', reason: 'TypeError' },
    ]);
  });

  it('blocks when the cached bytes are not a document this build can parse', async () => {
    const wrongBody = bytesOf('<!doctype html><title>Sign in</title>');
    const song = await documentEntry('song-grace', SONG_URL, SONG_MODEL);
    const pinned: readonly PinnedEntry[] = [{ ...song, hash: recordedDigest(wrongBody), bytes: wrongBody.length }];
    const cache = fakeCache(new Map([[SONG_URL, wrongBody]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.blockers).toEqual([
      { code: 'document.unreadable', documentId: 'song-grace', reason: 'SyntaxError' },
    ]);
  });

  it('blocks when the cached document is JSON and not an object', async () => {
    const wrongBody = bytesOf('null');
    const song = await documentEntry('song-grace', SONG_URL, SONG_MODEL);
    const pinned: readonly PinnedEntry[] = [{ ...song, hash: recordedDigest(wrongBody), bytes: wrongBody.length }];
    const cache = fakeCache(new Map([[SONG_URL, wrongBody]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.blockers).toEqual([
      { code: 'document.unreadable', documentId: 'song-grace', reason: 'TypeError' },
    ]);
  });

  it('names a render that failed with something that is not an error', async () => {
    const { pinned, seed } = await snapshot();
    const cache = fakeCache(seed);
    // A measurement that came back from a worker as a bare string rather than an error: there is no
    // name to report, and the rehearsal still answers instead of throwing at its caller.
    const brokenMeasurer: TextMeasurer = {
      measure: () => Promise.reject('the measurement worker was terminated'),
      close: () => Promise.resolve(),
    };

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: brokenMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([
      { code: 'render.failed', documentId: 'song-grace', reason: 'Error' },
      { code: 'render.failed', documentId: 'reading-psalm-23', reason: 'Error' },
    ]);
  });

  it('blocks when the renderer refuses the cached model', async () => {
    // The injection: a document pinned by a build whose renderer accepted a slide carrying its own
    // aspect ratio. This one refuses it, and a rehearsal reports that rather than throwing it at a
    // caller who was asking a yes-or-no question.
    const refused = {
      ...SONG_MODEL,
      slides: [{ ...SONG_MODEL.slides[0], aspectRatio: { width: 4, height: 3 } }],
    } as unknown as RenderModelInput;
    const body = jsonOf(refused);
    const pinned: readonly RehearsalDocument[] = [
      {
        id: 'song-grace',
        url: SONG_URL,
        necessity: 'mandatory',
        hash: recordedDigest(body),
        bytes: body.length,
        frameHash: await frameDigestOf(SONG_MODEL),
      },
    ];
    const cache = fakeCache(new Map([[SONG_URL, body]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toEqual([
      { code: 'render.failed', documentId: 'song-grace', reason: 'RenderModelError' },
    ]);
    expect(report.documents[0]?.slideIds).toEqual([]);
  });

  it('blocks when the renderer grades a slide unfit to show', async () => {
    // Text that does not fit its box at the minimum readable size: the renderer renders it, whole and at
    // the floor, and grades it blocked. A slide nothing may put on a wall is not one an offline service
    // may promise either.
    const unfit: RenderModelInput = {
      id: 'notice',
      outputType: 'main',
      slides: [
        {
          id: 'notice-1',
          boxes: [
            {
              id: 'notice-text',
              kind: 'text',
              text: 'The church council meets on the first Tuesday of every month in the lower hall',
              frame: { x: 0.1, y: 0.3, width: 0.2, height: 0.1 },
              font: { family: 'Inter', weight: 400, sizeRatio: 0.08, lineHeight: 1.2 },
              importance: 'required',
            },
          ],
        },
      ],
    };
    const pinned: readonly PinnedEntry[] = [await documentEntry('notice', SONG_URL, unfit)];
    const cache = fakeCache(new Map([[SONG_URL, jsonOf(unfit)]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    expect(report.kind).toBe('blocked');
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatchObject({ code: 'render.blocked', documentId: 'notice' });
    // The renderer's own verdict is carried, not re-encoded: readiness grades the slide, and this module
    // grades the rehearsal.
    expect(report.documents[0]?.findings.map((found) => found.code)).toContain(
      'text.overflowsAtMinimumReadableSize',
    );
    expect(report.documents[0]?.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------------------
// What a blocked rehearsal reports
// ---------------------------------------------------------------------------------------------------

describe('what a blocked rehearsal reports', () => {
  it('names every document that failed rather than stopping at the first', async () => {
    const { pinned, seed } = await snapshot();
    const broken = replacing(pinned, 'song-grace', { frameHash: '' });
    const cache = fakeCache(seed, { evictAfter: { url: READING_URL, reads: 1 } });

    const report = await rehearsePreparation(broken, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    // Two different repairs, reported together, so an operator fixes the whole thing once rather than
    // rediscovering the next problem after each attempt.
    expect(report.blockers).toEqual([
      { code: 'document.frameHashUnknown', documentId: 'song-grace' },
      { code: 'document.notCached', documentId: 'reading-psalm-23' },
    ]);
    expect(report.documents).toHaveLength(2);
    expect(report.rehearsedSlideIds).toEqual([]);
  });

  it('rehearses a snapshot the renderer only warned about', async () => {
    const decorated: RenderModelInput = {
      id: 'song-grace',
      outputType: 'main',
      slides: [
        {
          id: 'grace-verse-1',
          boxes: [
            ...textSlide('grace-verse-1', 'Amazing grace, how sweet the sound').boxes,
            // A band across the very top of the canvas, deliberately outside the safe area.
            { id: 'top-band', kind: 'decoration', frame: { x: 0, y: 0, width: 1, height: 0.04 }, importance: 'decoration' },
          ],
        },
      ],
    };
    const pinned: readonly PinnedEntry[] = [await documentEntry('song-grace', SONG_URL, decorated)];
    const cache = fakeCache(new Map([[SONG_URL, jsonOf(decorated)]]));

    const report = await rehearsePreparation(pinned, { cache: cache.cache, subtle, measurer: onlineMeasurer });

    // A warning is something to look at, not a reason to refuse an offline service that renders exactly
    // what it rendered online.
    expect(report.kind).toBe('rehearsed');
    expect(report.documents[0]?.findings.map((found) => found.code)).toEqual(['decoration.outsideSafeArea']);
    expect(report.blockers).toEqual([]);
  });
});
