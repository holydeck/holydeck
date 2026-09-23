import { createHash, randomBytes } from 'node:crypto';

import { EntityError, archivedStamp, createdStamp, parseEntityStamp, restoredStamp, touchedStamp } from '@holydeck/contracts/entities';
import { parseMediaManifestEntry, sniffMediaType } from '@holydeck/contracts/media';

import { requestContext } from './context.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { RECORDS, permissionsFor } from './records.js';
import { sweep } from './retention.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { MediaManifestEntry } from '@holydeck/contracts/media';
import type { Db } from 'mongodb';
import type { RequestContext } from './context.js';
import type { Queue } from './queue.js';
import type { RetainedCandidate, RetentionCandidate, SweepOutcome } from './retention.js';
import type { Document, RepositoryDb } from './repositories.js';

export const MEDIA_ASSET_RECORD = 'mediaAssets';
export const MEDIA_INGEST_KIND = 'media-ingest';

export const MEDIA_ASSET_PERMISSIONS = permissionsFor(MEDIA_ASSET_RECORD);

export interface MediaIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and it serves the only read this store makes by asset: the standing stamp of one media
// asset. Unique, so the rule that a stamp history grows by one is the database's rule too, and a second
// writer reaching the same ordinal collides on the key rather than on the record.
const DECLARED_INDEXES: readonly MediaIndex[] = [
  { name: 'media_asset_stamp', keys: { assetId: 1, sequence: -1 }, options: { unique: true } },
];

export const MEDIA_INDEXES = Object.freeze(DECLARED_INDEXES);

const STAMP_SEPARATOR = '#';

const MS_PER_DAY = 86_400_000;

export interface MediaStorageIO {
  /** Stores bytes below this deployment's configured media root and returns their durable handle. */
  write(root: string, key: string, bytes: Uint8Array): Promise<string>;
  /** Reads bytes from a durable handle returned by write. */
  read(root: string, key: string): Promise<Uint8Array>;
  /** Physically deletes bytes at a durable handle returned by write — reached only from
   *  `purgeArchived` (OPS-14), never from any of this file's other operations. */
  remove(root: string, key: string): Promise<void>;
}

export type MediaRefusal = 'schema' | 'invalid-type' | 'duplicate' | 'state' | 'corrupt';

export class MediaError extends Error {
  readonly kind: MediaRefusal;

  constructor(kind: MediaRefusal, message: string) {
    super(message);
    this.name = 'MediaError';
    this.kind = kind;
  }
}

export interface MediaUpload {
  readonly bytes: Uint8Array;
  /** Recorded nowhere and trusted never: content bytes decide the stored type. */
  readonly name?: string;
  /** Recorded nowhere and trusted never: content bytes decide the stored type. */
  readonly type?: string;
}

export interface MediaRecord {
  readonly stamp: EntityStamp;
  readonly manifest: MediaManifestEntry;
  readonly storageKey: string;
}

interface Filter {
  readonly [key: string]: unknown;
}

/** The slice of a Mongo collection `purgeArchived` needs to physically remove rows — narrower even
 *  than `notification-store.ts`'s own delete adapter, since purge only ever needs one bulk delete
 *  by `assetId`. No `Repository`/`RepositoryCollection` exposes this (ADR 0009), so this is its own
 *  adapter, the same way `NotificationDb`/`NotificationCollection` is its own. */
export interface MediaPurgeCollection {
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
}

export interface MediaPurgeDb {
  collection(name: string): MediaPurgeCollection;
}

/** The Mongo driver adapter for archived-media purge deletion (OPS-14) — the one place media.ts is
 *  allowed to physically remove a row. */
export function mediaPurgeDb(db: Db): MediaPurgeDb {
  return { collection: (name) => db.collection(name) as unknown as MediaPurgeCollection };
}

/** What grades and grants purge eligibility: the grace window (a settings value the caller reads
 *  and supplies — this file has no settings access of its own) and how to learn whether an asset is
 *  still referenced. No content model in this codebase tracks media references yet — the same gap
 *  `retention-sweep-handler.ts` already documents and defers for autosave-revision — so this is
 *  injectable rather than resolved internally, and fully testable by that injection. */
export interface MediaPurgeOptions {
  readonly graceDays: number;
  readonly referencedBy: (assetId: string) => readonly string[];
}

export interface MediaPurgeOutcome {
  readonly purged: readonly string[];
  readonly retained: readonly RetainedCandidate[];
}

export type MediaPurgeCategory = 'grace-period' | 'eligible' | 'protected';

/** One row of `purgeReport`'s output: the same data `purgeArchived` would act on if run right now,
 *  graded but not touched. */
export interface MediaPurgeItem {
  readonly id: string;
  readonly bytes: number;
  readonly type: string;
  readonly hash: string;
  readonly archivedAt: string | undefined;
  readonly category: MediaPurgeCategory;
  /** Set whenever category is not `'eligible'` — `retention.ts`'s own refusal message. */
  readonly reason: string | undefined;
  /** Set only when category is `'grace-period'`: the first instant this item becomes eligible. */
  readonly purgeableAt: string | undefined;
}

export interface MediaPurgeReport {
  readonly items: readonly MediaPurgeItem[];
}

export interface MediaLibrary {
  upload(context: unknown, upload: MediaUpload): Promise<MediaRecord>;
  inspect(context: unknown, id: string): Promise<MediaRecord | undefined>;
  list(context: unknown): Promise<readonly MediaRecord[]>;
  archive(context: unknown, id: string): Promise<MediaRecord | undefined>;
  restore(context: unknown, id: string): Promise<MediaRecord | undefined>;
  startProcessing(context: unknown, id: string): Promise<MediaRecord | undefined>;
  completeProcessing(context: unknown, id: string, derivatives: MediaManifestEntry['derivatives']): Promise<MediaRecord | undefined>;
  failProcessing(context: unknown, id: string): Promise<MediaRecord | undefined>;
  retryProcessing(context: unknown, id: string): Promise<MediaRecord | undefined>;
  /** Explicit, Admin-triggered (OPS-14) — never run by the daily retention sweep. Removes every
   *  archived asset past `options.graceDays` and not reported referenced by `options.referencedBy`,
   *  both the database rows and the stored bytes. Never auto-deletes: this method only runs when a
   *  caller (Task 10-19's route) calls it. */
  purgeArchived(context: unknown, options: MediaPurgeOptions): Promise<MediaPurgeOutcome>;
  /** Read-only twin of `purgeArchived` (OPS-15): the same grading, none of the deletion. Every
   *  current media row, categorized `'protected'` (still live, or archived but referenced),
   *  `'grace-period'` (archived, not yet past `options.graceDays`) or `'eligible'` (archived, past
   *  grace, unreferenced) — the exact three categories a purge would act on if run right now. */
  purgeReport(context: unknown, options: MediaPurgeOptions): Promise<MediaPurgeReport>;
}

export interface MediaLibraryOptions extends MediaStorageIO {
  readonly queue: Pick<Queue, 'enqueue'>;
  readonly now: () => string;
  readonly mediaRoot: string;
  readonly newId?: () => string;
  readonly purge: MediaPurgeDb;
}

const ID_BYTES = 16;

const HASH = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function mediaContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [...Object.values(MEDIA_ASSET_PERMISSIONS), QUEUE_PERMISSIONS.enqueue], correlationId });
}

function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new MediaError('state', error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') return new MediaError('duplicate', error.message);
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

/** The same candidate-grading step `purgeArchived` and `purgeReport` both need: every archived row,
 *  graded by `retention.ts`'s `sweep` under the `media-asset` class and this call's own
 *  `graceDays`/`referencedBy`. A pure function — nothing here reads or writes a database. */
function mediaPurgeCandidates(
  rows: readonly (MediaRecord & { readonly sequence: number })[],
  purgeOptions: MediaPurgeOptions,
  nowMs: number,
): SweepOutcome {
  const candidates: RetentionCandidate[] = rows
    .filter((row) => row.stamp.archivedAt !== undefined)
    .map((row) => ({
      id: row.stamp.id,
      class: 'media-asset',
      ageDays: Math.floor((nowMs - Date.parse(row.stamp.archivedAt as string)) / MS_PER_DAY),
      protectedBy: purgeOptions.referencedBy(row.stamp.id),
    }));
  return sweep(candidates, { 'media-asset': purgeOptions.graceDays });
}

export function mediaLibraryOn(db: RepositoryDb, options: MediaLibraryOptions): MediaLibrary {
  const records = repositoriesOn(db)[MEDIA_ASSET_RECORD];
  const newId = options.newId ?? (() => randomBytes(ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Document): MediaRecord & { readonly sequence: number } => {
    const assetId = found['assetId'];
    const sequence = found['sequence'];
    const storageKey = found['storageKey'];
    if (typeof assetId !== 'string' || typeof sequence !== 'number' || typeof storageKey !== 'string') {
      throw new MediaError('corrupt', 'a media asset is missing its identifier, ordinal, or storage handle');
    }
    const stamp = parseEntityStamp(found['stamp']);
    if (!stamp.ok || stamp.value.kind !== 'mediaAsset' || stamp.value.id !== assetId) {
      throw new MediaError('corrupt', `media asset ${assetId} holds a stamp this code cannot read`);
    }
    const manifest = parseMediaManifestEntry(found['manifest'], 'manifest');
    if (!manifest.ok || manifest.value.id !== assetId) {
      throw new MediaError('corrupt', `media asset ${assetId} holds a manifest this code cannot read`);
    }
    return { stamp: stamp.value, manifest: manifest.value, storageKey, sequence };
  };

  const standing = async (context: unknown, id: string): Promise<(MediaRecord & { readonly sequence: number }) | undefined> => {
    const [found] = await records.read(context, { assetId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const everything = async (context: unknown): Promise<readonly (MediaRecord & { readonly sequence: number })[]> => {
    const current = new Map<string, MediaRecord & { readonly sequence: number }>();
    for (const found of await records.read(context)) {
      const row = rowFrom(found);
      const previous = current.get(row.stamp.id);
      if (previous === undefined || previous.sequence < row.sequence) current.set(row.stamp.id, row);
    }
    return [...current.values()];
  };

  const append = async (context: unknown, record: MediaRecord, sequence: number): Promise<MediaRecord> => {
    const { actor, correlationId } = author(context);
    await records.append(context, {
      _id: `${record.stamp.id}${STAMP_SEPARATOR}${sequence}`,
      actor,
      correlationId,
      assetId: record.stamp.id,
      sequence,
      at: record.stamp.updatedAt,
      manifest: record.manifest,
      storageKey: record.storageKey,
      stamp: record.stamp,
    });
    return record;
  };

  const publicOf = (row: MediaRecord & { readonly sequence: number }): MediaRecord => ({
    stamp: row.stamp,
    manifest: row.manifest,
    storageKey: row.storageKey,
  });

  const processing = async (
    context: unknown,
    id: string,
    state: MediaManifestEntry['processingState'],
    derivatives: MediaManifestEntry['derivatives'],
  ): Promise<MediaRecord | undefined> => {
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    const manifest: MediaManifestEntry = { ...row.manifest, processingState: state, derivatives };
    const parsed = parseMediaManifestEntry(manifest, 'manifest');
    if (!parsed.ok) throw new MediaError('schema', 'the generated media manifest is invalid');
    return append(
      context,
      { ...row, stamp: touchedStamp(row.stamp, { at: options.now(), by: author(context).actor }), manifest: parsed.value },
      row.sequence + 1,
    );
  };

  return {
    upload: (context, upload) =>
      own(async () => {
        if (!(upload.bytes instanceof Uint8Array)) throw new MediaError('schema', 'media bytes must be a byte buffer');
        const type = sniffMediaType(upload.bytes);
        if (type === undefined) throw new MediaError('invalid-type', 'media bytes are not a supported v1 media or font type');
        const hash = HASH(upload.bytes);
        if ((await everything(context)).some((record) => record.manifest.hash === hash)) {
          throw new MediaError('duplicate', 'these media bytes are already in the library');
        }
        const id = newId();
        if ((await standing(context, id)) !== undefined) throw new MediaError('duplicate', `${id} is already a media asset`);
        const { actor } = author(context);
        const manifest: MediaManifestEntry = { id, bytes: upload.bytes.byteLength, hash, type, processingState: 'pending', derivatives: [] };
        const parsed = parseMediaManifestEntry(manifest, 'manifest');
        if (!parsed.ok) throw new MediaError('schema', 'the generated media manifest is invalid');
        const storageKey = await options.write(options.mediaRoot, id, upload.bytes);
        const record = await append(
          context,
          { stamp: createdStamp({ id, kind: 'mediaAsset', at: options.now(), by: actor }), manifest: parsed.value, storageKey },
          1,
        );
        await options.queue.enqueue(context, {
          kind: MEDIA_INGEST_KIND,
          idempotencyKey: `${MEDIA_INGEST_KIND}:${id}`,
          payload: { assetId: id },
        });
        return record;
      }),

    inspect: (context, id) => own(async () => {
      const row = await standing(context, id);
      return row === undefined ? undefined : publicOf(row);
    }),

    list: (context) => own(async () => (await everything(context)).map(publicOf)),

    archive: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return append(context, { ...row, stamp: archivedStamp(row.stamp, { at: options.now(), by: author(context).actor }) }, row.sequence + 1);
      }),

    restore: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return append(context, { ...row, stamp: restoredStamp(row.stamp, { at: options.now(), by: author(context).actor }) }, row.sequence + 1);
      }),

    startProcessing: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined || row.manifest.processingState === 'processing' || row.manifest.processingState === 'ready') {
          return row === undefined ? undefined : publicOf(row);
        }
        if (row.manifest.processingState !== 'pending') {
          throw new MediaError('state', `${id} is ${row.manifest.processingState}, not pending`);
        }
        return processing(context, id, 'processing', []);
      }),

    completeProcessing: (context, id, derivatives) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (row.manifest.processingState !== 'processing') {
          throw new MediaError('state', `${id} is ${row.manifest.processingState}, not processing`);
        }
        return processing(context, id, 'ready', derivatives);
      }),

    failProcessing: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (row.manifest.processingState !== 'processing') {
          throw new MediaError('state', `${id} is ${row.manifest.processingState}, not processing`);
        }
        return processing(context, id, 'failed', []);
      }),

    retryProcessing: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (row.manifest.processingState !== 'failed') {
          throw new MediaError('state', `${id} is ${row.manifest.processingState}, not failed`);
        }
        return processing(context, id, 'pending', []);
      }),

    purgeArchived: (context, purgeOptions) =>
      own(async () => {
        const rows = await everything(context);
        const { removable, retained } = mediaPurgeCandidates(rows, purgeOptions, Date.parse(options.now()));

        const purged: string[] = [];
        for (const id of removable) {
          const row = rows.find((candidate) => candidate.stamp.id === id);
          if (row === undefined) continue;
          await options.purge.collection(RECORDS.mediaAssets.collection).deleteMany({ assetId: id });
          await options.remove(options.mediaRoot, row.storageKey);
          purged.push(id);
        }
        return { purged, retained };
      }),

    purgeReport: (context, purgeOptions) =>
      own(async () => {
        const rows = await everything(context);
        const { removable, retained } = mediaPurgeCandidates(rows, purgeOptions, Date.parse(options.now()));
        const removableIds = new Set(removable);
        const retainedById = new Map(retained.map((entry) => [entry.id, entry]));

        const items: MediaPurgeItem[] = rows.map((row) => {
          const { archivedAt } = row.stamp;
          const base = { id: row.stamp.id, bytes: row.manifest.bytes, type: row.manifest.type, hash: row.manifest.hash, archivedAt };
          if (archivedAt === undefined) {
            return { ...base, category: 'protected' as const, reason: undefined, purgeableAt: undefined };
          }
          if (removableIds.has(row.stamp.id)) {
            return { ...base, category: 'eligible' as const, reason: undefined, purgeableAt: undefined };
          }
          const retainedEntry = retainedById.get(row.stamp.id);
          if (retainedEntry?.reason === 'too-recent') {
            return {
              ...base,
              category: 'grace-period' as const,
              reason: retainedEntry.message,
              purgeableAt: new Date(Date.parse(archivedAt) + purgeOptions.graceDays * MS_PER_DAY).toISOString(),
            };
          }
          return { ...base, category: 'protected' as const, reason: retainedEntry?.message, purgeableAt: undefined };
        });
        return { items };
      }),
  };
}
