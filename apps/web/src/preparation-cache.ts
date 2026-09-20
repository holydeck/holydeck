// Complete, verified caching of a pinned snapshot (OFFL-02): fetching every pinned document and asset,
// checking each one against the digest the manifest recorded, writing it, reading it back, and reporting
// per asset what it cost and what went wrong. Invariant 7 lets a service present offline only from a
// "capacity-checked, completely cached, hash-verified, locally rehearsed snapshot"; `preparation-storage.ts`
// is the capacity check, this file is the middle two, and OFFL-03's rehearsal is the last.
//
// The rule this module exists to keep is that nothing is *called* cached that was not verified. Every
// success below has had its bytes hashed after they reached the cache, not before: what a Sunday morning
// reads is the cache's copy, so the cache's copy is what has to match. That costs one extra local read
// per asset, deliberately, and it is the only way a corrupt entry — a truncated write, an eviction that
// took the tail, an origin that already held something else at that url — becomes a caught defect at
// preparation time rather than a blank screen mid-service.
//
// It does not re-check storage capacity. `preflightPreparationStorage` is called once, before this, on
// the assets that still have to be fetched (`planPreparationCache` is what produces that list), and
// re-deriving admission per asset here would compare a plan against `StorageEstimate.usage` — an
// origin-wide figure that already counts this service's own previously cached bytes, so a re-prepare
// would block on its own copy. The one storage fact this module reports is the browser's own refusal of
// a write, as `cache.writeFailed`; that is an answer, not an estimate.
//
// Every browser API is injected, as `preparation-storage.ts` injects `navigator.storage` and
// `local-output.ts` injects fullscreen: there is no `caches`, no `fetch`, no `crypto` and no clock in
// this file, so every branch below is reachable from a fixture.
//
// Nothing here is localized and nothing here is a sentence. A failure carries a code, the asset it
// belongs to, and the numbers behind it; the surface that shows one owns the wording.

import type { AssetNecessity, PreparationAsset } from './preparation-storage.js';

/**
 * One pinned document or asset, as the manifest that pinned it recorded it, plus the two things fetching
 * needs: where it is served from and what it must hash to.
 *
 * It extends `PreparationAsset` rather than restating it so a plan can be handed straight to
 * `preflightPreparationStorage`, which is how `planPreparationCache`'s `pending` list is meant to be
 * used. `bytes` stays optional there and is never read here: a recorded size is admission's input, while
 * this module reports the size it actually measured off the bytes it cached.
 */
export interface PinnedEntry extends PreparationAsset {
  readonly url: string;
  /** The manifest's digest of these bytes, `sha256:<hex>` or `sha256-<hex>`. */
  readonly hash: string;
}

/** What WebCrypto is asked for. The manifest writes the algorithm as `sha256`; WebCrypto names the same
 *  one `SHA-256`, and the translation between the two labels lives here rather than in a manifest. */
export const DIGEST_ALGORITHM = 'SHA-256';

/**
 * The two digest forms this codebase already writes, read as the same fact.
 *
 * `packages/contracts/src/revisions.ts` addresses a content revision as `sha256-<hex>`; the media
 * manifest in `apps/app/src/media.ts` records `sha256:<hex>`. A pinned snapshot holds both kinds of
 * thing, so both separators are accepted — and neither is invented here. Anything else, including a
 * digest of the wrong length or from another algorithm, is refused rather than guessed at: an asset
 * nothing can verify must never be reported as verified.
 */
const RECORDED_DIGEST = /^sha256[:-]([0-9a-fA-F]{64})$/u;

/**
 * How many times one asset is fetched before the preparation gives up on it.
 *
 * Three is this task's own figure. One attempt turns a single dropped packet into a failed preparation;
 * an unbounded retry turns a file the server no longer has into a progress bar that never finishes. Two
 * retries cover the transient cases worth covering — a blip, and a body that arrived wrong once — and
 * leave the third failure meaning what it says. A refused cache write is excluded from this budget on
 * purpose: see `cache.writeFailed`.
 */
export const MAX_CACHE_ATTEMPTS = 3;

/**
 * Why an asset is not in the cache. Each code names a different fix: repair the manifest, restore the
 * file on the server, free some room, or accept that this browser cannot verify anything.
 *
 * `hash.mismatch` and `cache.unverified` are deliberately not one code. The first says the bytes the
 * server sends are not the bytes the manifest pinned — a broken deployment. The second says the bytes
 * arrived sound and the cache does not hold them — a broken storage. Merging them would make one
 * reported problem mean two unrelated repairs.
 */
export type PreparationCacheFailureCode =
  | 'asset.hashUnknown'
  | 'fetch.failed'
  | 'hash.mismatch'
  | 'hash.unverifiable'
  | 'cache.writeFailed'
  | 'cache.unverified';

export interface PreparationCacheFailure {
  readonly code: PreparationCacheFailureCode;
  readonly assetId: string;
  readonly necessity: AssetNecessity;
  /** Network fetches made before giving up. Zero when nothing was ever fetched. */
  readonly attempts: number;
  /** The last status a server actually answered with, when one did. Absent after a network error, which
   *  is a different thing to act on than a 404. */
  readonly status?: number;
}

/**
 * What became of one pinned entry.
 *
 * `bytes` is measured, never recorded: it is the length of what the cache holds, which is the only byte
 * count this module can honestly report for an asset whose manifest entry carries no size. A caller
 * comparing the sum against what admission estimated does it with
 * `estimateMatchesCachedBytes(estimatedBytes, report.cachedBytes)`.
 *
 * `repairs` counts bodies that failed verification and were discarded — a corrupt entry already in the
 * cache, a truncated download, a write the cache did not keep. A completed asset with `repairs` above
 * zero is a preparation that worked and a manifest, server or storage that needs looking at.
 */
export interface PreparationEntryReport {
  readonly assetId: string;
  readonly necessity: AssetNecessity;
  readonly state: 'cached' | 'failed';
  readonly bytes: number;
  readonly attempts: number;
  readonly repairs: number;
  /** Present exactly when `state` is `failed`. */
  readonly failure?: PreparationCacheFailure;
}

/**
 * What the whole preparation came to.
 *
 * `kind` is `complete` only when every *mandatory* entry is cached and verified. A partial cache is
 * therefore never complete, and an optional asset that could not be fetched leaves a snapshot that is
 * complete and degraded — named in `degradedAssetIds` and in `failures`, so the report stays actionable
 * rather than silently smaller than the service someone prepared.
 */
export interface PreparationCacheReport {
  readonly kind: 'complete' | 'incomplete';
  readonly entries: readonly PreparationEntryReport[];
  readonly cachedBytes: number;
  readonly failures: readonly PreparationCacheFailure[];
  readonly degradedAssetIds: readonly string[];
}

/**
 * Where an asset is in its journey into the cache. `repairing` is its own phase because it is the one a
 * person watching a progress bar needs explained: the count went backwards because something did not
 * verify, not because the preparation is stuck.
 */
export type PreparationCachePhase = 'fetching' | 'verifying' | 'repairing' | 'cached' | 'failed';

/**
 * One progress event. Every event carries the running totals as well as the asset it is about, so a
 * surface can draw the whole bar from any single event without keeping its own tally. On a terminal
 * event (`cached` or `failed`) the asset it names is already counted in `completedAssets`.
 */
export interface PreparationCacheProgress {
  readonly assetId: string;
  readonly phase: PreparationCachePhase;
  /** The 1-based fetch this event belongs to; zero when no fetch was needed or none had started. */
  readonly attempt: number;
  /** Bytes this asset accounts for at this moment: what was fetched or what is cached, else zero. */
  readonly bytes: number;
  readonly completedAssets: number;
  readonly totalAssets: number;
  readonly cachedBytes: number;
}

export interface PreparationCacheOptions {
  readonly onProgress?: (progress: PreparationCacheProgress) => void;
}

/**
 * A payload, as everything here passes one around: bytes over a plain `ArrayBuffer`.
 *
 * The narrower type is WebCrypto's requirement rather than a preference — `digest` refuses a view over
 * a `SharedArrayBuffer`, so a payload that could be one is a payload that could not be verified, and
 * this module has nothing to do with bytes it cannot verify.
 */
export type PreparationBytes = Uint8Array<ArrayBuffer>;

/** A cached body, read the one way this module reads bodies. */
export interface PreparationBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PreparationResponseLike extends PreparationBodyLike {
  readonly ok: boolean;
  readonly status: number;
}

/**
 * The whole of the Cache API this client needs.
 *
 * `put` takes bytes rather than a response on purpose: the body was already read once to hash it, and a
 * response body reads once. An adapter over the real `Cache` wraps these bytes in a `Response` — which
 * is also where a caller decides what headers a cached entry carries, a decision this module has no
 * business making.
 */
export interface PreparationCacheLike {
  match(url: string): Promise<PreparationBodyLike | undefined>;
  put(url: string, bytes: PreparationBytes): Promise<void>;
  delete(url: string): Promise<boolean>;
}

/** The one thing `crypto.subtle` is asked for. */
export interface PreparationSubtleLike {
  digest(algorithm: string, data: PreparationBytes): Promise<ArrayBuffer>;
}

export interface PreparationCacheClients {
  readonly cache: PreparationCacheLike;
  readonly fetch: (url: string) => Promise<PreparationResponseLike>;
  readonly subtle: PreparationSubtleLike;
}

const hexOf = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The digest the manifest pinned, in the one form this module compares in, or nothing when what was
 *  recorded is not a digest it can check at all. */
const recordedDigestOf = (hash: string): string | undefined =>
  RECORDED_DIGEST.exec(hash)?.[1]?.toLowerCase();

/** The digest of these bytes, or nothing when this browser cannot compute one. An unverifiable asset is
 *  never a verified one, so the absent answer is carried rather than thrown. */
const digestOf = async (subtle: PreparationSubtleLike, bytes: PreparationBytes): Promise<string | undefined> => {
  try {
    return hexOf(await subtle.digest(DIGEST_ALGORITHM, bytes));
  } catch {
    return undefined;
  }
};

/** What the cache holds at this url, or nothing. A read that throws is nothing known — neither a hit nor
 *  a corruption — and is answered by fetching, which is the same thing an absent entry is answered by. */
const readCached = async (cache: PreparationCacheLike, url: string): Promise<PreparationBytes | undefined> => {
  try {
    const held = await cache.match(url);
    return held === undefined ? undefined : new Uint8Array(await held.arrayBuffer());
  } catch {
    return undefined;
  }
};

const discard = async (cache: PreparationCacheLike, url: string): Promise<void> => {
  try {
    await cache.delete(url);
  } catch {
    // A cache that will not drop a bad entry is not a reason to stop: sound bytes are written over it,
    // and every read of it is verified again anyway.
  }
};

interface Download {
  readonly bytes?: PreparationBytes;
  readonly status?: number;
}

const download = async (
  fetch: PreparationCacheClients['fetch'],
  url: string,
): Promise<Download> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return { status: response.status };
    return { bytes: new Uint8Array(await response.arrayBuffer()), status: response.status };
  } catch {
    // A network error left no status behind, and saying so is more useful than inventing one.
    return {};
  }
};

type Emit = (phase: PreparationCachePhase, attempt: number, bytes: number) => void;

const failureOf = (
  entry: PinnedEntry,
  code: PreparationCacheFailureCode,
  attempts: number,
  status?: number,
): PreparationCacheFailure =>
  Object.freeze({
    code,
    assetId: entry.id,
    necessity: entry.necessity,
    attempts,
    ...(code === 'fetch.failed' && status !== undefined ? { status } : {}),
  });

const failed = (
  entry: PinnedEntry,
  code: PreparationCacheFailureCode,
  attempts: number,
  repairs: number,
  status?: number,
): PreparationEntryReport => ({
  assetId: entry.id,
  necessity: entry.necessity,
  state: 'failed',
  bytes: 0,
  attempts,
  repairs,
  failure: failureOf(entry, code, attempts, status),
});

const cached = (entry: PinnedEntry, bytes: number, attempts: number, repairs: number): PreparationEntryReport => ({
  assetId: entry.id,
  necessity: entry.necessity,
  state: 'cached',
  bytes,
  attempts,
  repairs,
});

/**
 * Gets one pinned entry into the cache, verified, or explains why it is not there.
 *
 * The order is what makes this resumable and what makes it safe. A sound entry already in the cache is
 * reused without a byte of network; an entry that is there and wrong is dropped and re-fetched; a body
 * that does not match the manifest is never written at all; and a body that is written is read back and
 * hashed again before this function will call it cached.
 */
async function cacheEntry(
  entry: PinnedEntry,
  { cache, fetch, subtle }: PreparationCacheClients,
  emit: Emit,
): Promise<PreparationEntryReport> {
  const pinned = recordedDigestOf(entry.hash);
  // Nothing is fetched for an asset that could not be verified once it arrived: caching it would put
  // bytes nobody can vouch for behind an offline service that promises the opposite.
  if (pinned === undefined) return failed(entry, 'asset.hashUnknown', 0, 0);

  let repairs = 0;
  const held = await readCached(cache, entry.url);
  if (held !== undefined) {
    emit('verifying', 0, held.length);
    const digest = await digestOf(subtle, held);
    if (digest === undefined) return failed(entry, 'hash.unverifiable', 0, repairs);
    if (digest === pinned) return cached(entry, held.length, 0, repairs);
    repairs += 1;
    emit('repairing', 0, 0);
    await discard(cache, entry.url);
  }

  let code: PreparationCacheFailureCode = 'fetch.failed';
  let status: number | undefined;
  for (let attempt = 1; attempt <= MAX_CACHE_ATTEMPTS; attempt += 1) {
    emit('fetching', attempt, 0);
    const { bytes, status: answered } = await download(fetch, entry.url);
    status = answered;
    if (bytes === undefined) {
      code = 'fetch.failed';
      continue;
    }

    emit('verifying', attempt, bytes.length);
    const digest = await digestOf(subtle, bytes);
    // A browser with no digest to give will not have one on the next attempt either, and fetching the
    // same bytes again to not check them again helps nobody.
    if (digest === undefined) return failed(entry, 'hash.unverifiable', attempt, repairs);
    if (digest !== pinned) {
      repairs += 1;
      code = 'hash.mismatch';
      emit('repairing', attempt, 0);
      continue;
    }

    try {
      await cache.put(entry.url, bytes);
    } catch {
      // A refused write is the browser's own answer about room, not a blip: the same bytes would be
      // refused again, so this is where the asset stops rather than where the retry budget is spent.
      return failed(entry, 'cache.writeFailed', attempt, repairs);
    }

    const stored = await readCached(cache, entry.url);
    if (stored !== undefined && (await digestOf(subtle, stored)) === pinned) {
      return cached(entry, stored.length, attempt, repairs);
    }
    repairs += 1;
    code = 'cache.unverified';
    emit('repairing', attempt, 0);
    await discard(cache, entry.url);
  }

  return failed(entry, code, MAX_CACHE_ATTEMPTS, repairs, status);
}

const notify = (onProgress: PreparationCacheOptions['onProgress'], progress: PreparationCacheProgress): void => {
  if (onProgress === undefined) return;
  try {
    onProgress(progress);
  } catch {
    // A surface that throws while being told about progress loses the progress, not the preparation.
  }
};

/**
 * Caches a pinned snapshot completely, verifying every entry against the manifest.
 *
 * Entries are taken one at a time, in manifest order: progress stays monotonic and readable, and a slow
 * connection is spent on one asset at a time rather than split between all of them. Nothing here is a
 * transaction — a run that ends `incomplete` leaves every asset it did verify in the cache, which is
 * what makes calling it again after a repair resume rather than restart.
 */
export async function cachePreparation(
  entries: readonly PinnedEntry[],
  clients: PreparationCacheClients,
  options: PreparationCacheOptions = {},
): Promise<PreparationCacheReport> {
  const reports: PreparationEntryReport[] = [];
  const failures: PreparationCacheFailure[] = [];
  const degradedAssetIds: string[] = [];
  let cachedBytes = 0;
  let completedAssets = 0;

  for (const entry of entries) {
    const emit: Emit = (phase, attempt, bytes) =>
      notify(options.onProgress, {
        assetId: entry.id,
        phase,
        attempt,
        bytes,
        completedAssets,
        totalAssets: entries.length,
        cachedBytes,
      });

    const report = await cacheEntry(entry, clients, emit);
    reports.push(report);
    completedAssets += 1;
    cachedBytes += report.bytes;
    if (report.failure !== undefined) {
      failures.push(report.failure);
      if (entry.necessity === 'optional') degradedAssetIds.push(entry.id);
    }
    emit(report.state, report.attempts, report.bytes);
  }

  return {
    kind: failures.some((failure) => failure.necessity === 'mandatory') ? 'incomplete' : 'complete',
    entries: Object.freeze(reports),
    cachedBytes,
    failures: Object.freeze(failures),
    degradedAssetIds: Object.freeze(degradedAssetIds),
  };
}

/**
 * What a preparation still has to fetch, and what it already holds verified.
 *
 * This is the list to hand `preflightPreparationStorage`, not the whole manifest. Admission compares
 * required bytes against `StorageEstimate.usage`, which is the whole origin's consumption — including
 * the bytes a previous preparation of this same service already cached. Preflighting the whole manifest
 * therefore counts those bytes twice and can block a re-prepare on its own existing copy; preflighting
 * `pending` counts only bytes that still have to arrive, which is what the estimate is supposed to mean.
 *
 * It verifies, so the answer is trustworthy: an entry is only `cached` here if what the cache holds
 * hashes to what the manifest pinned. Anything else — absent, unreadable, corrupt, or recorded with a
 * digest that cannot be checked — is pending, because all of them still cost their bytes.
 */
export interface PreparationCachePlan {
  readonly pending: readonly PinnedEntry[];
  readonly cachedAssetIds: readonly string[];
  /** Entries the cache holds that are not what the manifest pinned. They are in `pending` as well: this
   *  list is what makes a silent re-download explainable. */
  readonly corruptAssetIds: readonly string[];
  readonly cachedBytes: number;
}

export async function planPreparationCache(
  entries: readonly PinnedEntry[],
  { cache, subtle }: Pick<PreparationCacheClients, 'cache' | 'subtle'>,
): Promise<PreparationCachePlan> {
  const pending: PinnedEntry[] = [];
  const cachedAssetIds: string[] = [];
  const corruptAssetIds: string[] = [];
  let cachedBytes = 0;

  for (const entry of entries) {
    const pinned = recordedDigestOf(entry.hash);
    const held = pinned === undefined ? undefined : await readCached(cache, entry.url);
    const digest = held === undefined ? undefined : await digestOf(subtle, held);
    if (held !== undefined && digest === pinned) {
      cachedAssetIds.push(entry.id);
      cachedBytes += held.length;
      continue;
    }
    // Only bytes that are present and provably wrong are corrupt. Bytes this browser cannot hash are
    // unverified, which is a fact about the browser rather than about the entry.
    if (held !== undefined && digest !== undefined) corruptAssetIds.push(entry.id);
    pending.push(entry);
  }

  return {
    pending: Object.freeze(pending),
    cachedAssetIds: Object.freeze(cachedAssetIds),
    corruptAssetIds: Object.freeze(corruptAssetIds),
    cachedBytes,
  };
}
