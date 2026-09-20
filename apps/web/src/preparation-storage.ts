// Capacity admission before a service is cached for offline use (OFFL-01): how much room a pinned
// preparation needs, how much this browser actually has, whether the cache can be made persistent, and —
// when the answer is no — which named blocker a surface shows instead of a progress bar that was never
// going to finish.
//
// This decides only whether caching may begin. It caches nothing itself, on purpose: a gate that also
// did the work could not be the thing asked *before* the work. Fetching, hashing and verifying every
// pinned document and asset is OFFL-02's, and the local render rehearsal that follows a complete cache
// is OFFL-03's; neither is imported here and neither is anticipated beyond the two numbers this module
// hands them (`estimatedBytes`, and `estimateMatchesCachedBytes` for checking that estimate against what
// caching really took).
//
// The vocabulary below is this module's own. `packages/renderer/src/readiness.ts` grades a *slide* —
// text that will not fit, content outside the safe area, media louder than its bound — and shares
// nothing with capacity beyond the word "blocker"; reusing its codes here would have made one list mean
// two unrelated things, so this file names its own three, the way `presentation-transitions.ts` named
// its own outcome and fallback rather than borrowing an enum that merely looked close enough.
//
// Every browser API it touches is injected, as `local-output.ts` injects fullscreen and wake lock and
// `output-launch.ts` injects the window opener: `navigator.storage` is never reached for inside this
// logic, so every branch below — including the ones a developer machine with terabytes free would never
// take — is reachable from a fixture. There is no `navigator`, no `caches`, no `fetch` and no clock in
// this file.
//
// Nothing here is localized. A blocker carries a code and the bytes behind it, never a sentence: the
// surface that shows one owns the wording in the reader's own language, the same separation
// `stage-state.ts` keeps between what is true and how it reads.

/** Whether the preparation is still the prepared service without this asset. A mandatory asset that
 *  cannot be cached blocks; an optional one is dropped from the plan and reported as skipped. */
export type AssetNecessity = 'mandatory' | 'optional';

/**
 * One asset a pinned snapshot needs offline, as the manifest that pinned it recorded it.
 *
 * `bytes` absent is not zero and not "unknown but probably small": it is an asset nothing can promise
 * room for, because admission is arithmetic over recorded sizes and there is no number to add. That is
 * the only "cannot be cached" this preflight can honestly know — a fetch that fails, a hash that does
 * not match, a server that has dropped the file are all discovered by OFFL-02 while caching, not before
 * it starts.
 */
export interface PreparationAsset {
  readonly id: string;
  readonly necessity: AssetNecessity;
  readonly bytes?: number;
}

/**
 * How far the bytes a cache really occupies may land from this estimate before the estimate was simply
 * wrong. OFFL-02 checks its measured total against the estimate with `estimateMatchesCachedBytes`, so a
 * manifest whose recorded sizes stop describing what gets cached fails a build rather than a Sunday.
 *
 * Ten percent is this task's own figure and provisional, in the same sense as
 * `presentation-transitions.ts`'s `TRANSITION_BUDGET_MS`: it is the room a cache entry's headers, index
 * record and filesystem block rounding were assumed to need on top of a payload, and no real cache has
 * been measured against it yet. OFFL-02 is what confirms or corrects it. The assumption is weakest for a
 * service made of very many very small assets, where per-entry overhead is a larger share of each one.
 */
export const ESTIMATE_TOLERANCE_RATIO = 0.1;

/**
 * The margin admission insists on above the estimate before letting caching begin.
 *
 * It exists because a preparation admitted for exactly the bytes it was estimated at is a preparation
 * that runs out if the estimate lands at the far end of its own tolerance. Keeping this at or above
 * `ESTIMATE_TOLERANCE_RATIO` is what makes an admitted preparation one that still fits when the estimate
 * was as wrong as it is allowed to be; the module's test asserts that relationship, so lowering this
 * without lowering the tolerance is a red build rather than an eviction mid-service.
 */
export const ADMISSION_HEADROOM_RATIO = 0.1;

const isMeasured = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

/** What the pinned assets weigh: the recorded sizes added up, and nothing invented for the ones with no
 *  size recorded — those are answered by `necessity`, not by a guessed number. */
export function estimateRequiredBytes(assets: readonly PreparationAsset[]): number {
  return assets.reduce((total, asset) => (isMeasured(asset.bytes) ? total + asset.bytes : total), 0);
}

/** What must be free for caching to be admitted: the estimate plus the headroom above it, rounded up so
 *  admission never turns on a fraction of a byte. */
export function admissionBytesFor(estimatedBytes: number): number {
  return Math.ceil(estimatedBytes * (1 + ADMISSION_HEADROOM_RATIO));
}

/**
 * Whether what caching really took matches what was estimated before it started. OFFL-02 calls this with
 * its measured total; overrunning and under-running both fail it, because an estimate that does not
 * describe the cache is the estimate the *next* service's admission is decided on either way.
 */
export function estimateMatchesCachedBytes(estimatedBytes: number, cachedBytes: number): boolean {
  return Math.abs(cachedBytes - estimatedBytes) <= estimatedBytes * ESTIMATE_TOLERANCE_RATIO;
}

/** The two fields this module reads from a storage estimate. Both are optional in the API itself, and a
 *  browser answering without a quota has told us nothing about capacity. */
export interface StorageEstimateLike {
  readonly quota?: number;
  readonly usage?: number;
}

/** The whole of `navigator.storage` this client needs: what room there is, and a request to keep what it
 *  stores. Both are optional because a browser may have neither, and an absent one must be a branch a
 *  fixture can take rather than a `TypeError` on a Sunday. */
export interface PreparationStorageLike {
  estimate?: () => Promise<StorageEstimateLike>;
  persist?: () => Promise<boolean>;
}

/** What became of the request to keep this origin's storage. `refused` covers both a browser that said
 *  no and one that threw instead of saying so: we asked, and we did not get it. `unsupported` is a
 *  browser with no such request to make, which is a different fact and left a different way. */
export type PersistenceState = 'granted' | 'refused' | 'unsupported';

/**
 * Why caching may not begin. Three codes, each naming a distinct fix: free some room, repair the
 * manifest, or accept that this browser cannot promise an offline service at all.
 *
 * `requiredBytes` is what admission demanded free — the estimate *and* its headroom — not the estimate
 * alone, because the only actionable number for a person staring at a full disk is how much they have
 * to clear.
 */
export type PreparationBlocker =
  | { readonly code: 'storage.estimateUnavailable' }
  | {
      readonly code: 'storage.quotaShortfall';
      readonly requiredBytes: number;
      readonly availableBytes: number;
      readonly shortfallBytes: number;
    }
  | { readonly code: 'asset.sizeUnknown'; readonly assetId: string };

export type PreparationBlockerCode = PreparationBlocker['code'];

/**
 * The preflight's answer. `admitted` carries the numbers OFFL-02 needs to cache against and OFFL-03's
 * readiness marker needs to report; `blocked` carries every reason at once, in a fixed order — the
 * assets that cannot be sized, in manifest order, then the single storage-wide finding — so an operator
 * fixes the whole thing once rather than rediscovering the next problem after each repair.
 */
export type PreparationPreflight =
  | {
      readonly kind: 'admitted';
      readonly estimatedBytes: number;
      readonly requiredBytes: number;
      readonly availableBytes: number;
      readonly persistence: PersistenceState;
      /** Optional assets left out of the plan because nothing recorded their size. */
      readonly skippedAssetIds: readonly string[];
    }
  | { readonly kind: 'blocked'; readonly blockers: readonly PreparationBlocker[] };

/** Room left for this origin. A browser reporting more used than it grants — a recalculated quota, an
 *  eviction pass that has not run yet — is simply full, never negative. */
const availableBytesOf = (estimate: StorageEstimateLike): number | undefined => {
  if (!isMeasured(estimate.quota)) return undefined;
  const used = isMeasured(estimate.usage) ? estimate.usage : 0;
  return Math.max(0, estimate.quota - used);
};

const measure = async (storage: PreparationStorageLike): Promise<number | undefined> => {
  if (typeof storage.estimate !== 'function') return undefined;
  try {
    return availableBytesOf(await storage.estimate());
  } catch {
    // A storage that cannot be measured is treated exactly as one that cannot be asked: neither can tell
    // us this service will still be here on Sunday.
    return undefined;
  }
};

const requestPersistence = async (storage: PreparationStorageLike): Promise<PersistenceState> => {
  if (typeof storage.persist !== 'function') return 'unsupported';
  try {
    return (await storage.persist()) ? 'granted' : 'refused';
  } catch {
    return 'refused';
  }
};

/**
 * Decides whether this browser can hold the prepared service, before a single byte of it is cached.
 *
 * The order is the point. Sizes first, then capacity, and persistence only once both have passed: a
 * preparation that cannot complete never asks the person in front of the screen for a storage permission
 * it has no use for, and never starts a cache it would have to abandon half-written. A blocked answer
 * therefore proves, by construction, that nothing was requested and nothing was written — there is no
 * path through this function that reaches `persist()` with a blocker in hand.
 *
 * An evictable cache is not a blocker. A browser that refuses persistence, or has no way to grant it,
 * still holds the service well enough to be worth caching; the risk that it is evicted is reported as
 * `persistence` for a surface to say out loud, and OFFL-02's verification is what catches an eviction
 * that actually happened. A browser that cannot say how much room it has is different in kind: there is
 * no admission decision to be made at all, so readiness is refused rather than promised on a guess.
 */
export async function preflightPreparationStorage(
  storage: PreparationStorageLike,
  assets: readonly PreparationAsset[],
): Promise<PreparationPreflight> {
  const blockers: PreparationBlocker[] = [];
  const skippedAssetIds: string[] = [];
  for (const asset of assets) {
    if (isMeasured(asset.bytes)) continue;
    if (asset.necessity === 'mandatory') {
      blockers.push(Object.freeze({ code: 'asset.sizeUnknown' as const, assetId: asset.id }));
    } else {
      skippedAssetIds.push(asset.id);
    }
  }

  const estimatedBytes = estimateRequiredBytes(assets);
  const requiredBytes = admissionBytesFor(estimatedBytes);
  const availableBytes = await measure(storage);

  if (availableBytes === undefined) {
    blockers.push(Object.freeze({ code: 'storage.estimateUnavailable' as const }));
    return { kind: 'blocked', blockers: Object.freeze(blockers) };
  }

  if (availableBytes < requiredBytes) {
    blockers.push(
      Object.freeze({
        code: 'storage.quotaShortfall' as const,
        requiredBytes,
        availableBytes,
        shortfallBytes: requiredBytes - availableBytes,
      }),
    );
  }

  if (blockers.length > 0) return { kind: 'blocked', blockers: Object.freeze(blockers) };

  return {
    kind: 'admitted',
    estimatedBytes,
    requiredBytes,
    availableBytes,
    persistence: await requestPersistence(storage),
    skippedAssetIds: Object.freeze(skippedAssetIds),
  };
}
