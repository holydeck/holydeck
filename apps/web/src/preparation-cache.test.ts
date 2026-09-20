import { createHash, webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_CACHE_ATTEMPTS,
  type PinnedEntry,
  type PreparationBodyLike,
  type PreparationCacheLike,
  type PreparationCacheProgress,
  type PreparationResponseLike,
  type PreparationSubtleLike,
  cachePreparation,
  planPreparationCache,
} from './preparation-cache.js';
import { estimateMatchesCachedBytes, estimateRequiredBytes } from './preparation-storage.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The manifest's own digest form, computed by a different implementation than the one under test:
 *  fixtures use Node's `createHash`, the module verifies with WebCrypto, and a disagreement between the
 *  two would be a failure rather than a pair of matching mistakes. */
const recordedDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

// One Sunday's pinned snapshot: the manifest itself, a generated slide group, and the two media files
// that make up most of its bytes. `sermon-background` deliberately records no size — the pinned manifest
// carries no byte count for media today, and a preparation still has to cache it.
const MANIFEST_BODY = bytesOf('{"snapshot":"svc-2026-09-21","pins":{"service":"svc#3"}}');
const SLIDES_BODY = bytesOf('Grace — verse 1\nGrace — verse 2\nGrace — chorus\n');
const BACKGROUND_BODY = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
const CLOSING_BODY = Uint8Array.from({ length: 2048 }, (_, index) => (index * 7) % 253);

const MANIFEST_URL = '/snapshots/svc-2026-09-21/manifest.json';
const SLIDES_URL = '/snapshots/svc-2026-09-21/song-grace.json';
const BACKGROUND_URL = '/media/sermon-background.png';
const CLOSING_URL = '/media/closing.mp4';

const PINNED: readonly PinnedEntry[] = [
  {
    id: 'snapshot-manifest',
    url: MANIFEST_URL,
    hash: recordedDigest(MANIFEST_BODY),
    necessity: 'mandatory',
    bytes: MANIFEST_BODY.length,
  },
  {
    id: 'song-grace-slides',
    url: SLIDES_URL,
    hash: recordedDigest(SLIDES_BODY),
    necessity: 'mandatory',
    bytes: SLIDES_BODY.length,
  },
  { id: 'sermon-background', url: BACKGROUND_URL, hash: recordedDigest(BACKGROUND_BODY), necessity: 'mandatory' },
  {
    id: 'closing-video',
    url: CLOSING_URL,
    hash: recordedDigest(CLOSING_BODY),
    necessity: 'optional',
    bytes: CLOSING_BODY.length,
  },
];

const [MANIFEST_ENTRY, SLIDES_ENTRY, BACKGROUND_ENTRY, CLOSING_ENTRY] = PINNED as readonly [
  PinnedEntry,
  PinnedEntry,
  PinnedEntry,
  PinnedEntry,
];

const SERVED: ReadonlyMap<string, Uint8Array> = new Map([
  [MANIFEST_URL, MANIFEST_BODY],
  [SLIDES_URL, SLIDES_BODY],
  [BACKGROUND_URL, BACKGROUND_BODY],
  [CLOSING_URL, CLOSING_BODY],
]);

const TOTAL_BYTES = MANIFEST_BODY.length + SLIDES_BODY.length + BACKGROUND_BODY.length + CLOSING_BODY.length;

/** Bytes that are not the file they are stored under: a truncated download, a half-written entry, an
 *  eviction that took the tail. Whatever produced them, they hash to something else. */
const CORRUPT_BODY = bytesOf('this file did not finish downloading');

// ---------------------------------------------------------------------------------------------------
// The browser capabilities, injected
// ---------------------------------------------------------------------------------------------------

/** The real WebCrypto, so hash verification in these tests is hash verification and not a stub that
 *  agrees with itself. */
const subtle: PreparationSubtleLike = webcrypto.subtle;

/** A browser that cannot digest anything at all — no secure context, no SubtleCrypto. */
const uselessSubtle: PreparationSubtleLike = {
  digest: async () => {
    throw new Error('SubtleCrypto is unavailable in an insecure context');
  },
};

interface FakeCache {
  readonly cache: PreparationCacheLike;
  /** What the cache actually holds, so "the sound bytes are what stayed" is asserted, not assumed. */
  readonly stored: Map<string, Uint8Array>;
  readonly calls: { match: number; put: number; delete: number };
}

const fakeCache = (
  options: {
    readonly seed?: ReadonlyMap<string, Uint8Array>;
    /** A cache whose read throws instead of answering. */
    readonly matchThrowsFor?: string;
    /** A cache that refuses the write — a full quota, a storage the browser has closed. */
    readonly putThrowsFor?: string;
    readonly deleteThrows?: boolean;
    /** A cache that accepts the write and then holds something other than what it was handed. */
    readonly mangleOnPut?: boolean;
    /** A cache that accepts the write and then holds nothing — evicted between put and read. */
    readonly dropOnPut?: boolean;
  } = {},
): FakeCache => {
  const stored = new Map<string, Uint8Array>(options.seed);
  const calls = { match: 0, put: 0, delete: 0 };
  const body = (bytes: Uint8Array): PreparationBodyLike => ({ arrayBuffer: async () => toArrayBuffer(bytes) });
  return {
    stored,
    calls,
    cache: {
      match: async (url) => {
        calls.match += 1;
        if (options.matchThrowsFor === url) throw new Error('the cache could not be opened');
        const held = stored.get(url);
        return held === undefined ? undefined : body(held);
      },
      put: async (url, bytes) => {
        calls.put += 1;
        if (options.putThrowsFor === url) throw new Error('QuotaExceededError');
        if (options.dropOnPut === true) return;
        stored.set(url, options.mangleOnPut === true ? CORRUPT_BODY : bytes);
      },
      delete: async (url) => {
        calls.delete += 1;
        if (options.deleteThrows === true) throw new Error('the cache entry could not be removed');
        return stored.delete(url);
      },
    },
  };
};

type FetchVerdict = 'ok' | 'network-error' | 'not-found' | 'truncated';

interface FakeFetch {
  readonly fetch: (url: string) => Promise<PreparationResponseLike>;
  /** Every request made, in order, so an asset fetched twice is visible as two entries. */
  readonly requests: string[];
}

const fakeFetch = (script: (url: string, attempt: number) => FetchVerdict = () => 'ok'): FakeFetch => {
  const attempts = new Map<string, number>();
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url) => {
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      requests.push(url);
      const verdict = script(url, attempt);
      if (verdict === 'network-error') throw new TypeError('the network went away mid-service');
      if (verdict === 'not-found') {
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const served = verdict === 'truncated' ? CORRUPT_BODY : (SERVED.get(url) ?? new Uint8Array());
      return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(served) };
    },
  };
};

const collector = (): { events: PreparationCacheProgress[]; onProgress: (event: PreparationCacheProgress) => void } => {
  const events: PreparationCacheProgress[] = [];
  return { events, onProgress: (event) => events.push(event) };
};

// ---------------------------------------------------------------------------------------------------
// Caching every pinned document and asset
// ---------------------------------------------------------------------------------------------------

describe('caching every pinned document and asset', () => {
  it('caches every pinned entry and reports the snapshot complete', async () => {
    const cache = fakeCache();
    const network = fakeFetch();

    const report = await cachePreparation(PINNED, { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.cachedBytes).toBe(TOTAL_BYTES);
    expect(report.failures).toEqual([]);
    expect(report.degradedAssetIds).toEqual([]);
    expect(report.entries).toEqual([
      {
        assetId: 'snapshot-manifest',
        necessity: 'mandatory',
        state: 'cached',
        bytes: MANIFEST_BODY.length,
        attempts: 1,
        repairs: 0,
      },
      {
        assetId: 'song-grace-slides',
        necessity: 'mandatory',
        state: 'cached',
        bytes: SLIDES_BODY.length,
        attempts: 1,
        repairs: 0,
      },
      {
        assetId: 'sermon-background',
        necessity: 'mandatory',
        state: 'cached',
        bytes: BACKGROUND_BODY.length,
        attempts: 1,
        repairs: 0,
      },
      {
        assetId: 'closing-video',
        necessity: 'optional',
        state: 'cached',
        bytes: CLOSING_BODY.length,
        attempts: 1,
        repairs: 0,
      },
    ]);
    // Every pinned url was requested exactly once, and the bytes the cache kept are the bytes served.
    expect(network.requests).toEqual([MANIFEST_URL, SLIDES_URL, BACKGROUND_URL, CLOSING_URL]);
    expect(cache.stored.get(BACKGROUND_URL)).toEqual(BACKGROUND_BODY);
    expect([...cache.stored.keys()]).toEqual([MANIFEST_URL, SLIDES_URL, BACKGROUND_URL, CLOSING_URL]);
  });

  it('never reports complete when a mandatory asset could not be cached', async () => {
    const cache = fakeCache();
    const network = fakeFetch((url) => (url === BACKGROUND_URL ? 'network-error' : 'ok'));

    const report = await cachePreparation(PINNED, { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('incomplete');
    // The rest of the snapshot is still cached — a partial cache is reported partial, not discarded.
    expect(report.cachedBytes).toBe(TOTAL_BYTES - BACKGROUND_BODY.length);
    expect(cache.stored.has(BACKGROUND_URL)).toBe(false);
    expect(report.failures).toEqual([
      {
        code: 'fetch.failed',
        assetId: 'sermon-background',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    ]);
    expect(report.entries.map((entry) => entry.state)).toEqual(['cached', 'cached', 'failed', 'cached']);
    expect(report.degradedAssetIds).toEqual([]);
  });

  it('completes with the failure named when only an optional asset could not be cached', async () => {
    const cache = fakeCache();
    const network = fakeFetch((url) => (url === CLOSING_URL ? 'not-found' : 'ok'));

    const report = await cachePreparation(PINNED, { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.degradedAssetIds).toEqual(['closing-video']);
    expect(report.failures).toEqual([
      {
        code: 'fetch.failed',
        assetId: 'closing-video',
        necessity: 'optional',
        attempts: MAX_CACHE_ATTEMPTS,
        status: 404,
      },
    ]);
    expect(report.cachedBytes).toBe(TOTAL_BYTES - CLOSING_BODY.length);
  });

  it('reuses a cache entry that already matches the manifest rather than fetching it again', async () => {
    const cache = fakeCache({ seed: new Map([[BACKGROUND_URL, BACKGROUND_BODY]]) });
    const network = fakeFetch();

    const report = await cachePreparation(PINNED, { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.cachedBytes).toBe(TOTAL_BYTES);
    expect(network.requests).not.toContain(BACKGROUND_URL);
    expect(report.entries[2]).toEqual({
      assetId: 'sermon-background',
      necessity: 'mandatory',
      state: 'cached',
      bytes: BACKGROUND_BODY.length,
      attempts: 0,
      repairs: 0,
    });
  });

  it('treats a cache it cannot read as an asset not yet cached', async () => {
    const cache = fakeCache({ matchThrowsFor: MANIFEST_URL });
    const network = fakeFetch();

    const report = await cachePreparation([MANIFEST_ENTRY], {
      cache: cache.cache,
      fetch: network.fetch,
      subtle,
    });

    // The read that threw is neither a hit nor a corruption: it is nothing known, so the asset is
    // fetched. The read-back after the write throws too, so the write cannot be confirmed either.
    expect(network.requests).toEqual([MANIFEST_URL, MANIFEST_URL, MANIFEST_URL]);
    expect(report.failures).toEqual([
      {
        code: 'cache.unverified',
        assetId: 'snapshot-manifest',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// What a surface can show while a snapshot is caching
// ---------------------------------------------------------------------------------------------------

describe('what a surface can show while a snapshot is caching', () => {
  it('reports progress, attempts and measured bytes for every asset', async () => {
    const cache = fakeCache();
    const network = fakeFetch();
    const { events, onProgress } = collector();

    await cachePreparation([MANIFEST_ENTRY, SLIDES_ENTRY], {
      cache: cache.cache,
      fetch: network.fetch,
      subtle,
    }, { onProgress });

    expect(events).toEqual([
      {
        assetId: 'snapshot-manifest',
        phase: 'fetching',
        attempt: 1,
        bytes: 0,
        completedAssets: 0,
        totalAssets: 2,
        cachedBytes: 0,
      },
      {
        assetId: 'snapshot-manifest',
        phase: 'verifying',
        attempt: 1,
        bytes: MANIFEST_BODY.length,
        completedAssets: 0,
        totalAssets: 2,
        cachedBytes: 0,
      },
      {
        assetId: 'snapshot-manifest',
        phase: 'cached',
        attempt: 1,
        bytes: MANIFEST_BODY.length,
        completedAssets: 1,
        totalAssets: 2,
        cachedBytes: MANIFEST_BODY.length,
      },
      {
        assetId: 'song-grace-slides',
        phase: 'fetching',
        attempt: 1,
        bytes: 0,
        completedAssets: 1,
        totalAssets: 2,
        cachedBytes: MANIFEST_BODY.length,
      },
      {
        assetId: 'song-grace-slides',
        phase: 'verifying',
        attempt: 1,
        bytes: SLIDES_BODY.length,
        completedAssets: 1,
        totalAssets: 2,
        cachedBytes: MANIFEST_BODY.length,
      },
      {
        assetId: 'song-grace-slides',
        phase: 'cached',
        attempt: 1,
        bytes: SLIDES_BODY.length,
        completedAssets: 2,
        totalAssets: 2,
        cachedBytes: MANIFEST_BODY.length + SLIDES_BODY.length,
      },
    ]);
  });

  it('names the retry and the failure a watching surface has to explain', async () => {
    const cache = fakeCache();
    const network = fakeFetch((_url, attempt) => (attempt === 1 ? 'network-error' : 'not-found'));
    const { events, onProgress } = collector();

    await cachePreparation([MANIFEST_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle }, { onProgress });

    expect(events.map((event) => `${event.phase}#${event.attempt}`)).toEqual([
      'fetching#1',
      'fetching#2',
      'fetching#3',
      'failed#3',
    ]);
    expect(events.at(-1)).toEqual({
      assetId: 'snapshot-manifest',
      phase: 'failed',
      attempt: MAX_CACHE_ATTEMPTS,
      bytes: 0,
      completedAssets: 1,
      totalAssets: 1,
      cachedBytes: 0,
    });
  });

  it('measures the bytes it cached rather than trusting the sizes the manifest recorded', async () => {
    const cache = fakeCache();
    const network = fakeFetch();
    const sized = PINNED.filter((entry) => entry.bytes !== undefined);

    const whole = await cachePreparation(PINNED, { cache: cache.cache, fetch: network.fetch, subtle });
    const measured = await cachePreparation(sized, {
      cache: fakeCache().cache,
      fetch: fakeFetch().fetch,
      subtle,
    });

    // Every asset carries a measured size, including the one the manifest recorded none for: the byte
    // count comes off the bytes that were cached, never off a field that may not be there.
    expect(whole.entries.map((entry) => entry.bytes)).toEqual([
      MANIFEST_BODY.length,
      SLIDES_BODY.length,
      BACKGROUND_BODY.length,
      CLOSING_BODY.length,
    ]);
    // A plan whose sizes were all recorded lands inside T95's tolerance, so the estimate admission was
    // decided on describes the cache that resulted.
    expect(estimateMatchesCachedBytes(estimateRequiredBytes(sized), measured.cachedBytes)).toBe(true);
    // A plan with an unsized asset in it does not — which is exactly why an unsized *mandatory* asset
    // blocks admission in `preflightPreparationStorage` rather than being estimated at zero.
    expect(estimateMatchesCachedBytes(estimateRequiredBytes(PINNED), whole.cachedBytes)).toBe(false);
  });

  it('keeps caching when the surface watching progress throws', async () => {
    const cache = fakeCache();
    const network = fakeFetch();

    const report = await cachePreparation(
      PINNED,
      { cache: cache.cache, fetch: network.fetch, subtle },
      {
        onProgress: () => {
          throw new Error('the progress bar was removed from the document');
        },
      },
    );

    expect(report.kind).toBe('complete');
    expect(report.cachedBytes).toBe(TOTAL_BYTES);
  });
});

// ---------------------------------------------------------------------------------------------------
// Retrying an asset that did not arrive
// ---------------------------------------------------------------------------------------------------

describe('retrying an asset that did not arrive', () => {
  it('retries a failed fetch and reports the attempt it succeeded on', async () => {
    const cache = fakeCache();
    const network = fakeFetch((_url, attempt) => (attempt < 3 ? 'network-error' : 'ok'));

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.entries[0]).toEqual({
      assetId: 'song-grace-slides',
      necessity: 'mandatory',
      state: 'cached',
      bytes: SLIDES_BODY.length,
      attempts: 3,
      repairs: 0,
    });
    expect(network.requests).toHaveLength(3);
  });

  it('gives up after the attempt budget and names the fetch that never arrived', async () => {
    const cache = fakeCache();
    const network = fakeFetch(() => 'network-error');

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(network.requests).toHaveLength(MAX_CACHE_ATTEMPTS);
    expect(report.entries[0]).toEqual({
      assetId: 'song-grace-slides',
      necessity: 'mandatory',
      state: 'failed',
      bytes: 0,
      attempts: MAX_CACHE_ATTEMPTS,
      repairs: 0,
      failure: {
        code: 'fetch.failed',
        assetId: 'song-grace-slides',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    });
    // A network error left no status to report; a server that answered would have.
    expect(report.failures[0]?.status).toBeUndefined();
  });

  it('stops fetching bytes the cache has already refused to store', async () => {
    const cache = fakeCache({ putThrowsFor: SLIDES_URL });
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    // A refused write is the browser's own answer about room, not a blip: fetching the same bytes again
    // would be answered the same way, so one attempt is where it stops.
    expect(network.requests).toHaveLength(1);
    expect(cache.calls.put).toBe(1);
    expect(report.failures).toEqual([
      { code: 'cache.writeFailed', assetId: 'song-grace-slides', necessity: 'mandatory', attempts: 1 },
    ]);
    expect(report.kind).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------------------------------
// Verifying every cached asset against the manifest
// ---------------------------------------------------------------------------------------------------

describe('verifying every cached asset against the manifest', () => {
  it('re-fetches a body whose digest does not match the manifest', async () => {
    const cache = fakeCache();
    const network = fakeFetch((_url, attempt) => (attempt === 1 ? 'truncated' : 'ok'));

    const report = await cachePreparation([BACKGROUND_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.entries[0]).toEqual({
      assetId: 'sermon-background',
      necessity: 'mandatory',
      state: 'cached',
      bytes: BACKGROUND_BODY.length,
      attempts: 2,
      repairs: 1,
    });
    // The body that did not match was never written: only the sound one reached the cache.
    expect(cache.calls.put).toBe(1);
    expect(cache.stored.get(BACKGROUND_URL)).toEqual(BACKGROUND_BODY);
  });

  it('never reports an asset cached whose digest never matched', async () => {
    const cache = fakeCache();
    const network = fakeFetch(() => 'truncated');

    const report = await cachePreparation([BACKGROUND_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('incomplete');
    expect(report.cachedBytes).toBe(0);
    expect(cache.stored.size).toBe(0);
    expect(cache.calls.put).toBe(0);
    expect(report.entries[0]).toMatchObject({
      state: 'failed',
      attempts: MAX_CACHE_ATTEMPTS,
      repairs: MAX_CACHE_ATTEMPTS,
    });
    expect(report.failures).toEqual([
      {
        code: 'hash.mismatch',
        assetId: 'sermon-background',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    ]);
  });

  it('refuses an asset the manifest recorded no usable digest for, without fetching it', async () => {
    const network = fakeFetch();
    const unusable: readonly PinnedEntry[] = [
      { id: 'no-hash', url: '/snapshots/x/none.json', hash: '', necessity: 'mandatory' },
      { id: 'short-hash', url: '/snapshots/x/short.json', hash: 'sha256:abc123', necessity: 'mandatory' },
      {
        id: 'other-algorithm',
        url: '/snapshots/x/md5.json',
        hash: `md5-${'0'.repeat(32)}`,
        necessity: 'optional',
      },
    ];

    const report = await cachePreparation(unusable, {
      cache: fakeCache().cache,
      fetch: network.fetch,
      subtle,
    });

    // Nothing is fetched for an asset that could never be verified once it arrived.
    expect(network.requests).toEqual([]);
    expect(report.kind).toBe('incomplete');
    expect(report.failures).toEqual([
      { code: 'asset.hashUnknown', assetId: 'no-hash', necessity: 'mandatory', attempts: 0 },
      { code: 'asset.hashUnknown', assetId: 'short-hash', necessity: 'mandatory', attempts: 0 },
      { code: 'asset.hashUnknown', assetId: 'other-algorithm', necessity: 'optional', attempts: 0 },
    ]);
    expect(report.degradedAssetIds).toEqual(['other-algorithm']);
  });

  it('reads the two digest forms this codebase already writes', async () => {
    const network = fakeFetch();
    // Revisions address a body as `sha256-<hex>` and the media manifest records `sha256:<hex>`; a pinned
    // snapshot holds both kinds of thing, so both are the same fact about the same bytes here.
    const dashed: PinnedEntry = {
      ...SLIDES_ENTRY,
      hash: recordedDigest(SLIDES_BODY).replace(':', '-').toUpperCase().replace('SHA256', 'sha256'),
    };

    const report = await cachePreparation([dashed], { cache: fakeCache().cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.cachedBytes).toBe(SLIDES_BODY.length);
  });

  it('fails an asset a browser cannot compute a digest for at all', async () => {
    const cache = fakeCache();
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], {
      cache: cache.cache,
      fetch: network.fetch,
      subtle: uselessSubtle,
    });

    // Unverifiable is not the same as wrong, and retrying a browser without SubtleCrypto fetches the
    // same bytes it still cannot check: one attempt, and nothing written.
    expect(network.requests).toHaveLength(1);
    expect(cache.stored.size).toBe(0);
    expect(report.failures).toEqual([
      { code: 'hash.unverifiable', assetId: 'song-grace-slides', necessity: 'mandatory', attempts: 1 },
    ]);
  });

  it('fails an asset already in the cache when nothing can hash what is there', async () => {
    const cache = fakeCache({ seed: new Map([[SLIDES_URL, SLIDES_BODY]]) });
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], {
      cache: cache.cache,
      fetch: network.fetch,
      subtle: uselessSubtle,
    });

    // The bytes in the cache are the right bytes. Nothing can say so, so nothing says so — and the
    // entry is not re-fetched either, because the copy that arrives is just as uncheckable.
    expect(network.requests).toEqual([]);
    expect(cache.stored.get(SLIDES_URL)).toEqual(SLIDES_BODY);
    expect(report.failures).toEqual([
      { code: 'hash.unverifiable', assetId: 'song-grace-slides', necessity: 'mandatory', attempts: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Failure injection: a corrupt cache entry (specification 14.3)
// ---------------------------------------------------------------------------------------------------

describe('failure injection: a corrupt cache entry', () => {
  it('detects a corrupt cache entry, re-fetches it, and leaves the sound bytes cached', async () => {
    // The injection: the origin already holds an entry at this asset's url, and those bytes are not the
    // asset. Nothing about the cache says so — only the manifest digest does.
    const cache = fakeCache({ seed: new Map([[BACKGROUND_URL, CORRUPT_BODY]]) });
    const network = fakeFetch();

    const report = await cachePreparation([BACKGROUND_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('complete');
    expect(report.entries[0]).toEqual({
      assetId: 'sermon-background',
      necessity: 'mandatory',
      state: 'cached',
      bytes: BACKGROUND_BODY.length,
      attempts: 1,
      repairs: 1,
    });
    // Detected: the corrupt entry was dropped rather than left to be served on Sunday. Re-fetched: the
    // network was asked for it once. Sound: what the cache holds now hashes to the pinned manifest.
    expect(cache.calls.delete).toBe(1);
    expect(network.requests).toEqual([BACKGROUND_URL]);
    expect(cache.stored.get(BACKGROUND_URL)).toEqual(BACKGROUND_BODY);
    expect(recordedDigest(cache.stored.get(BACKGROUND_URL) ?? new Uint8Array())).toBe(BACKGROUND_ENTRY.hash);
    expect(report.cachedBytes).toBe(BACKGROUND_BODY.length);
  });

  it('refuses to call an asset cached when the cache reads back something else', async () => {
    const cache = fakeCache({ mangleOnPut: true });
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    // The fetched body verified; the cache's copy of it did not. What Sunday reads is the cache's copy,
    // so that is what has to match.
    expect(report.kind).toBe('incomplete');
    expect(report.cachedBytes).toBe(0);
    expect(report.failures).toEqual([
      {
        code: 'cache.unverified',
        assetId: 'song-grace-slides',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    ]);
    expect(report.entries[0]).toMatchObject({ repairs: MAX_CACHE_ATTEMPTS });
    expect(cache.stored.has(SLIDES_URL)).toBe(false);
  });

  it('refuses to call an asset cached when the write left nothing behind', async () => {
    const cache = fakeCache({ dropOnPut: true });
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    expect(report.kind).toBe('incomplete');
    expect(report.failures).toEqual([
      {
        code: 'cache.unverified',
        assetId: 'song-grace-slides',
        necessity: 'mandatory',
        attempts: MAX_CACHE_ATTEMPTS,
      },
    ]);
  });

  it('survives a cache that will not delete the corrupt entry it found', async () => {
    const cache = fakeCache({ seed: new Map([[SLIDES_URL, CORRUPT_BODY]]), deleteThrows: true });
    const network = fakeFetch();

    const report = await cachePreparation([SLIDES_ENTRY], { cache: cache.cache, fetch: network.fetch, subtle });

    // The delete threw; the sound bytes were written over the corrupt ones anyway.
    expect(cache.calls.delete).toBe(1);
    expect(report.kind).toBe('complete');
    expect(cache.stored.get(SLIDES_URL)).toEqual(SLIDES_BODY);
  });
});

// ---------------------------------------------------------------------------------------------------
// Planning only the bytes that still have to be fetched
// ---------------------------------------------------------------------------------------------------

describe('planning only the bytes that still have to be fetched', () => {
  it('leaves out what the cache already holds verified, so admission is decided on new bytes', async () => {
    const cache = fakeCache({
      seed: new Map([
        [MANIFEST_URL, MANIFEST_BODY],
        [BACKGROUND_URL, BACKGROUND_BODY],
      ]),
    });

    const plan = await planPreparationCache(PINNED, { cache: cache.cache, subtle });

    expect(plan.cachedAssetIds).toEqual(['snapshot-manifest', 'sermon-background']);
    expect(plan.cachedBytes).toBe(MANIFEST_BODY.length + BACKGROUND_BODY.length);
    expect(plan.corruptAssetIds).toEqual([]);
    expect(plan.pending).toEqual([SLIDES_ENTRY, CLOSING_ENTRY]);
    // The point of the plan: what still has to be fetched is what storage admission is decided on, so a
    // re-prepared service is not blocked by the bytes its own earlier copy already occupies.
    expect(estimateRequiredBytes(plan.pending)).toBe(SLIDES_BODY.length + CLOSING_BODY.length);
    expect(estimateRequiredBytes(PINNED)).toBeGreaterThan(estimateRequiredBytes(plan.pending));
  });

  it('plans a corrupt entry as still to be fetched and names it', async () => {
    const cache = fakeCache({ seed: new Map([[SLIDES_URL, CORRUPT_BODY]]) });

    const plan = await planPreparationCache(PINNED, { cache: cache.cache, subtle });

    expect(plan.cachedAssetIds).toEqual([]);
    expect(plan.corruptAssetIds).toEqual(['song-grace-slides']);
    expect(plan.pending).toEqual(PINNED);
    expect(plan.cachedBytes).toBe(0);
  });

  it('plans an asset with no usable digest as pending rather than as cached', async () => {
    const unhashed: PinnedEntry = { id: 'no-hash', url: MANIFEST_URL, hash: '', necessity: 'mandatory' };
    const cache = fakeCache({ seed: new Map([[MANIFEST_URL, MANIFEST_BODY]]) });

    const plan = await planPreparationCache([unhashed], { cache: cache.cache, subtle });

    // The bytes are there, and nothing can say they are the right bytes: never counted as cached.
    expect(plan.cachedAssetIds).toEqual([]);
    expect(plan.corruptAssetIds).toEqual([]);
    expect(plan.pending).toEqual([unhashed]);
  });
});
