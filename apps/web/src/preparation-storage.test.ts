import { describe, expect, it } from 'vitest';

import {
  ADMISSION_HEADROOM_RATIO,
  ESTIMATE_TOLERANCE_RATIO,
  type PreparationAsset,
  type PreparationBlockerCode,
  type PreparationStorageLike,
  admissionBytesFor,
  estimateMatchesCachedBytes,
  estimateRequiredBytes,
  preflightPreparationStorage,
} from './preparation-storage.js';

const KIB = 1024;
const MIB = 1024 * 1024;

// One Sunday's worth of pinned assets, sized the way a prepared snapshot records them: a small manifest,
// slide payloads measured in kilobytes, and the media that actually decides whether a service fits.
const SERVICE: readonly PreparationAsset[] = [
  { id: 'snapshot-manifest', necessity: 'mandatory', bytes: 12 * KIB },
  { id: 'song-grace-slides', necessity: 'mandatory', bytes: 48 * KIB },
  { id: 'sermon-background', necessity: 'mandatory', bytes: 6 * MIB },
  { id: 'closing-video', necessity: 'optional', bytes: 40 * MIB },
];

/** The four sizes above, added up by hand, so a change to either the fixture or the sum is visible. */
const REQUIRED = 48_295_936;
/** What admission insists is free: the estimate plus its headroom, rounded up. */
const ADMISSION = 53_125_530;

/** A mandatory asset the manifest recorded no size for — nothing can promise room for it, so preparation
 *  cannot be admitted with it in the plan. T50 ships no bundled font, so this is a constructed fixture
 *  rather than a real asset pointed at. */
const UNSIZED_MANDATORY: PreparationAsset = { id: 'font-latin-subset', necessity: 'mandatory' };
const UNSIZED_OPTIONAL: PreparationAsset = { id: 'closing-video-hd', necessity: 'optional' };

interface FakeStorage {
  readonly storage: PreparationStorageLike;
  /** What the module actually called, so "never started a cache that cannot complete" is asserted rather
   *  than assumed: a preflight that blocks must not have asked the person for persistence either. */
  readonly calls: { estimate: number; persist: number };
}

const fakeStorage = (options: {
  readonly quota?: number;
  readonly usage?: number;
  readonly estimate?: 'rejects' | 'absent';
  readonly persist?: 'granted' | 'refused' | 'rejects' | 'absent';
}): FakeStorage => {
  const calls = { estimate: 0, persist: 0 };
  const estimate = async (): Promise<{ quota?: number; usage?: number }> => {
    calls.estimate += 1;
    if (options.estimate === 'rejects') throw new Error('storage cannot be measured');
    return { quota: options.quota, usage: options.usage };
  };
  const persist = async (): Promise<boolean> => {
    calls.persist += 1;
    if (options.persist === 'rejects') throw new Error('persistence refused outright');
    return options.persist !== 'refused';
  };
  return {
    storage: {
      ...(options.estimate === 'absent' ? {} : { estimate }),
      ...(options.persist === 'absent' ? {} : { persist }),
    },
    calls,
  };
};

/** Room to spare: half a gigabyte of quota with a hundred megabytes already spent. */
const roomy = (persist?: 'granted' | 'refused' | 'rejects' | 'absent'): FakeStorage =>
  fakeStorage({ quota: 512 * MIB, usage: 100 * MIB, ...(persist === undefined ? {} : { persist }) });

// ---------------------------------------------------------------------------------------------------
// What the service weighs
// ---------------------------------------------------------------------------------------------------

describe('estimating what a prepared service needs before anything is cached', () => {
  it('adds up the sizes the pinned manifest recorded and invents none of its own', () => {
    expect(estimateRequiredBytes(SERVICE)).toBe(REQUIRED);
    expect(estimateRequiredBytes([])).toBe(0);
    // An asset with no recorded size contributes nothing to the sum; whether it blocks is decided by
    // whether it is mandatory, not by pretending a number for it here.
    expect(estimateRequiredBytes([...SERVICE, UNSIZED_MANDATORY, UNSIZED_OPTIONAL])).toBe(REQUIRED);
    // A size no manifest could mean is no size either, never a number to add or subtract.
    expect(estimateRequiredBytes([{ id: 'corrupt-entry', necessity: 'mandatory', bytes: -1 }])).toBe(0);
    expect(
      estimateRequiredBytes([{ id: 'corrupt-entry', necessity: 'mandatory', bytes: Number.NaN }]),
    ).toBe(0);
  });

  it('lands within tolerance of what caching those bytes actually took', () => {
    // What a real cache costs on top of the payload: response headers, the cache index entry, and the
    // filesystem rounding each one up to a block. Four assets of this size put that well inside the
    // tolerance.
    expect(estimateMatchesCachedBytes(REQUIRED, REQUIRED + 4 * KIB * 4)).toBe(true);
    expect(estimateMatchesCachedBytes(REQUIRED, Math.round(REQUIRED * 1.04))).toBe(true);
    // A cache that took half again as much as the manifest said is an estimate that was wrong, not a
    // tolerance that should stretch to cover it.
    expect(estimateMatchesCachedBytes(REQUIRED, Math.round(REQUIRED * 1.5))).toBe(false);
    // Under-running by more than the tolerance is just as wrong: it means the manifest's recorded sizes
    // do not describe what was cached, and the next service's admission would be decided on them.
    expect(estimateMatchesCachedBytes(REQUIRED, Math.round(REQUIRED * 0.8))).toBe(false);
    expect(estimateMatchesCachedBytes(0, 0)).toBe(true);
  });

  it('treats the tolerance as the last acceptable byte and not the first unacceptable one', () => {
    // A size whose tenth is exact in binary, so the edge is pinned at a byte rather than at a rounding.
    const estimated = 40 * MIB;
    const tolerated = estimated * ESTIMATE_TOLERANCE_RATIO;

    expect(estimateMatchesCachedBytes(estimated, estimated + tolerated)).toBe(true);
    expect(estimateMatchesCachedBytes(estimated, estimated - tolerated)).toBe(true);
    expect(estimateMatchesCachedBytes(estimated, estimated + tolerated + 1)).toBe(false);
    expect(estimateMatchesCachedBytes(estimated, estimated - tolerated - 1)).toBe(false);
  });

  it("insists on a margin above the estimate that covers the estimate's own error", () => {
    expect(ESTIMATE_TOLERANCE_RATIO).toBe(0.1);
    expect(ADMISSION_HEADROOM_RATIO).toBe(0.1);
    // The invariant, not a coincidence of two equal numbers: a preparation admitted on the estimate must
    // still fit when the real cache lands at the far end of that estimate's tolerance.
    expect(ADMISSION_HEADROOM_RATIO).toBeGreaterThanOrEqual(ESTIMATE_TOLERANCE_RATIO);
    expect(admissionBytesFor(REQUIRED)).toBe(ADMISSION);
    expect(admissionBytesFor(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------------

describe('asking the browser to keep the cache', () => {
  it('requests persistence where it is supported and records that it was granted', async () => {
    const { storage, calls } = roomy('granted');

    const preflight = await preflightPreparationStorage(storage, SERVICE);

    expect(preflight).toEqual({
      kind: 'admitted',
      estimatedBytes: REQUIRED,
      requiredBytes: ADMISSION,
      availableBytes: 412 * MIB,
      persistence: 'granted',
      skippedAssetIds: [],
    });
    expect(calls.persist).toBe(1);
  });

  it('records a cache the browser may evict when persistence is refused, and admits it anyway', async () => {
    const refused = roomy('refused');
    const rejected = roomy('rejects');

    const afterRefusal = await preflightPreparationStorage(refused.storage, SERVICE);
    const afterRejection = await preflightPreparationStorage(rejected.storage, SERVICE);

    expect(afterRefusal).toMatchObject({ kind: 'admitted', persistence: 'refused' });
    expect(afterRejection).toMatchObject({ kind: 'admitted', persistence: 'refused' });
    expect(refused.calls.persist).toBe(1);
    expect(rejected.calls.persist).toBe(1);
  });

  it('never calls a persist the browser does not have, and still admits the preparation', async () => {
    const { storage, calls } = roomy('absent');

    const preflight = await preflightPreparationStorage(storage, SERVICE);

    expect(storage.persist).toBeUndefined();
    expect(preflight).toMatchObject({ kind: 'admitted', persistence: 'unsupported' });
    expect(calls.persist).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// A quota that cannot hold the service
// ---------------------------------------------------------------------------------------------------

describe('a quota too small for the service', () => {
  it('blocks with the shortfall named rather than starting a cache that cannot complete', async () => {
    const { storage, calls } = fakeStorage({ quota: 60 * MIB, usage: 20 * MIB });

    const preflight = await preflightPreparationStorage(storage, SERVICE);

    expect(preflight).toEqual({
      kind: 'blocked',
      blockers: [
        {
          code: 'storage.quotaShortfall',
          requiredBytes: ADMISSION,
          availableBytes: 40 * MIB,
          shortfallBytes: ADMISSION - 40 * MIB,
        },
      ],
    });
    // Nothing was asked of the person, and nothing was cached: the gate closed before either.
    expect(calls.persist).toBe(0);
  });

  it('blocks a storage that is already completely full before a single byte is written', async () => {
    const full = fakeStorage({ quota: 256 * MIB, usage: 256 * MIB });
    const overFull = fakeStorage({ quota: 256 * MIB, usage: 300 * MIB });

    const onFull = await preflightPreparationStorage(full.storage, SERVICE);
    const onOverFull = await preflightPreparationStorage(overFull.storage, SERVICE);

    expect(onFull).toEqual({
      kind: 'blocked',
      blockers: [
        {
          code: 'storage.quotaShortfall',
          requiredBytes: ADMISSION,
          availableBytes: 0,
          shortfallBytes: ADMISSION,
        },
      ],
    });
    // A browser reporting more used than it grants is still simply full, never negative room.
    expect(onOverFull).toEqual(onFull);
    expect(full.calls.persist).toBe(0);
    expect(overFull.calls.persist).toBe(0);
  });

  it('admits a service that fits with the margin, and blocks the one a byte short of it', async () => {
    const exact = fakeStorage({ quota: ADMISSION, usage: 0 });
    const short = fakeStorage({ quota: ADMISSION - 1, usage: 0 });

    const onExact = await preflightPreparationStorage(exact.storage, SERVICE);
    const onShort = await preflightPreparationStorage(short.storage, SERVICE);

    expect(onExact).toMatchObject({ kind: 'admitted', availableBytes: ADMISSION });
    expect(onShort).toMatchObject({
      kind: 'blocked',
      blockers: [{ code: 'storage.quotaShortfall', shortfallBytes: 1 }],
    });
  });

  it('names a blocker a surface can show without reading any of this module code', async () => {
    const { storage } = fakeStorage({ quota: 1 * MIB, usage: 0 });

    const preflight = await preflightPreparationStorage(storage, SERVICE);

    expect(preflight.kind).toBe('blocked');
    if (preflight.kind !== 'blocked') return;
    const [blocker] = preflight.blockers;
    const named: PreparationBlockerCode | undefined = blocker?.code;
    expect(named).toBe('storage.quotaShortfall');
    expect(Object.isFrozen(blocker)).toBe(true);
    expect(Object.isFrozen(preflight.blockers)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// An asset that cannot be cached at all
// ---------------------------------------------------------------------------------------------------

describe('an asset preparation cannot promise room for', () => {
  it('blocks readiness when it is mandatory, however much room there is', async () => {
    const { storage, calls } = roomy();

    const preflight = await preflightPreparationStorage(storage, [...SERVICE, UNSIZED_MANDATORY]);

    expect(preflight).toEqual({
      kind: 'blocked',
      blockers: [{ code: 'asset.sizeUnknown', assetId: 'font-latin-subset' }],
    });
    expect(calls.persist).toBe(0);

    // A recorded size that cannot be one blocks for exactly the same reason none at all does.
    const corrupt = roomy();
    expect(
      await preflightPreparationStorage(corrupt.storage, [
        ...SERVICE,
        { id: 'sermon-slides', necessity: 'mandatory', bytes: -1 },
      ]),
    ).toEqual({
      kind: 'blocked',
      blockers: [{ code: 'asset.sizeUnknown', assetId: 'sermon-slides' }],
    });
  });

  it('skips it and admits the rest when it is optional', async () => {
    const { storage } = roomy();

    const preflight = await preflightPreparationStorage(storage, [...SERVICE, UNSIZED_OPTIONAL]);

    expect(preflight).toEqual({
      kind: 'admitted',
      estimatedBytes: REQUIRED,
      requiredBytes: ADMISSION,
      availableBytes: 412 * MIB,
      persistence: 'granted',
      skippedAssetIds: ['closing-video-hd'],
    });
  });

  it('names every asset it cannot size alongside a shortfall, not only the first thing wrong', async () => {
    const { storage } = fakeStorage({ quota: 8 * MIB, usage: 0 });

    const preflight = await preflightPreparationStorage(storage, [
      UNSIZED_MANDATORY,
      ...SERVICE,
      { id: 'sermon-notes', necessity: 'mandatory' },
    ]);

    expect(preflight).toEqual({
      kind: 'blocked',
      blockers: [
        { code: 'asset.sizeUnknown', assetId: 'font-latin-subset' },
        { code: 'asset.sizeUnknown', assetId: 'sermon-notes' },
        {
          code: 'storage.quotaShortfall',
          requiredBytes: ADMISSION,
          availableBytes: 8 * MIB,
          shortfallBytes: ADMISSION - 8 * MIB,
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// A browser that cannot say how much room there is
// ---------------------------------------------------------------------------------------------------

describe('a browser that cannot measure its own storage', () => {
  it('blocks rather than promising an offline service nothing can verify', async () => {
    const absent = fakeStorage({ estimate: 'absent' });
    const rejecting = fakeStorage({ estimate: 'rejects' });
    const quotaless = fakeStorage({ usage: 0 });

    const onAbsent = await preflightPreparationStorage(absent.storage, SERVICE);
    const onRejecting = await preflightPreparationStorage(rejecting.storage, SERVICE);
    const onQuotaless = await preflightPreparationStorage(quotaless.storage, SERVICE);

    const blocked = { kind: 'blocked', blockers: [{ code: 'storage.estimateUnavailable' }] };
    expect(onAbsent).toEqual(blocked);
    expect(onRejecting).toEqual(blocked);
    expect(onQuotaless).toEqual(blocked);
    expect(absent.calls.persist).toBe(0);
    expect(rejecting.calls.persist).toBe(0);
    expect(quotaless.calls.persist).toBe(0);
  });

  it('refuses a quota reported without the usage to subtract from it', async () => {
    // An omitted usage is an absent measurement, never a measured zero. Reading it as zero would report
    // the whole quota as free and admit a preparation that then dies half-cached — the one mistake this
    // module could make that points the wrong way.
    const { storage, calls } = fakeStorage({ quota: 512 * MIB });

    const preflight = await preflightPreparationStorage(storage, SERVICE);

    expect(preflight).toEqual({
      kind: 'blocked',
      blockers: [{ code: 'storage.estimateUnavailable' }],
    });
    expect(calls.persist).toBe(0);
  });

  it('names the assets it cannot size alongside the storage it cannot measure', async () => {
    const { storage, calls } = fakeStorage({ estimate: 'absent' });

    const preflight = await preflightPreparationStorage(storage, [...SERVICE, UNSIZED_MANDATORY]);

    expect(preflight).toEqual({
      kind: 'blocked',
      blockers: [
        { code: 'asset.sizeUnknown', assetId: 'font-latin-subset' },
        { code: 'storage.estimateUnavailable' },
      ],
    });
    expect(calls.persist).toBe(0);
  });

  it('refuses a quota no browser could mean, the same way it refuses none at all', async () => {
    const negative = fakeStorage({ quota: -1, usage: 0 });
    const nonsense = fakeStorage({ quota: Number.NaN, usage: 0 });

    expect(await preflightPreparationStorage(negative.storage, SERVICE)).toEqual({
      kind: 'blocked',
      blockers: [{ code: 'storage.estimateUnavailable' }],
    });
    expect(await preflightPreparationStorage(nonsense.storage, SERVICE)).toEqual({
      kind: 'blocked',
      blockers: [{ code: 'storage.estimateUnavailable' }],
    });
  });
});
