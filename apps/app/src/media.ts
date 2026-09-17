import { createHash, randomBytes } from 'node:crypto';

import { EntityError, archivedStamp, createdStamp, parseEntityStamp, restoredStamp } from '@holydeck/contracts/entities';
import { parseMediaManifestEntry, sniffMediaType } from '@holydeck/contracts/media';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { MediaManifestEntry } from '@holydeck/contracts/media';
import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';

export const MEDIA_ASSET_RECORD = 'mediaAssets';

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

export interface MediaStorageIO {
  /** Stores bytes below this deployment's configured media root and returns their durable handle. */
  write(root: string, key: string, bytes: Uint8Array): Promise<string>;
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

export interface MediaLibrary {
  upload(context: unknown, upload: MediaUpload): Promise<MediaRecord>;
  inspect(context: unknown, id: string): Promise<MediaRecord | undefined>;
  get(context: unknown, id: string): Promise<MediaRecord | undefined>;
  list(context: unknown): Promise<readonly MediaRecord[]>;
  archive(context: unknown, id: string): Promise<MediaRecord | undefined>;
  restore(context: unknown, id: string): Promise<MediaRecord | undefined>;
}

export interface MediaLibraryOptions extends MediaStorageIO {
  readonly now: () => string;
  readonly mediaRoot: string;
  readonly newId?: () => string;
}

const ID_BYTES = 16;

const HASH = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function mediaContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(MEDIA_ASSET_PERMISSIONS), correlationId });
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
        return append(context, { stamp: createdStamp({ id, kind: 'mediaAsset', at: options.now(), by: actor }), manifest: parsed.value, storageKey }, 1);
      }),

    inspect: (context, id) => own(async () => {
      const row = await standing(context, id);
      return row === undefined ? undefined : publicOf(row);
    }),

    get: (context, id) => own(async () => {
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
  };
}
