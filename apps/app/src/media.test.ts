import { describe, expect, it } from 'vitest';

import { MediaError, mediaContext, mediaLibraryOn } from './media.js';
import { RECORDS } from './records.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { fakeMediaStorageIO } from '../test/helpers/media-storage-io.js';

import type { MediaLibrary } from './media.js';
import type { Queue } from './queue.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FakeMediaStorageIO } from '../test/helpers/media-storage-io.js';

const ADMIN = mediaContext(`account:${'D'.repeat(22)}`, 'req-media');

const png = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const store = (): { db: FakeDb; io: FakeMediaStorageIO; jobs: Array<Parameters<Queue['enqueue']>[1]>; media: MediaLibrary } => {
  const db = fakeDb();
  const io = fakeMediaStorageIO();
  const jobs: Array<Parameters<Queue['enqueue']>[1]> = [];
  let tick = 0;
  let serial = 0;
  return {
    db,
    io,
    jobs,
    media: mediaLibraryOn(db, {
      now: () => new Date(Date.parse('2026-09-17T09:30:00.000Z') + (tick += 1) * 1000).toISOString(),
      newId: () => `media-${(serial += 1)}`,
      mediaRoot: '/media',
      write: io.write,
      read: io.read,
      queue: {
        async enqueue(_context, input) {
          jobs.push(input);
          return { id: `job-${jobs.length}`, created: true };
        },
      },
    }),
  };
};

const refused = async (call: Promise<unknown>): Promise<MediaError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof MediaError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('the media library', () => {
  it('uploads and inspects a complete pending manifest', async () => {
    const { io, jobs, media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png(), name: 'actually-text.txt', type: 'text/plain' });

    expect(uploaded.manifest).toMatchObject({
      id: 'media-1',
      bytes: 9,
      type: 'image/png',
      processingState: 'pending',
      derivatives: [],
    });
    expect(uploaded.manifest.hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(uploaded.stamp.kind).toBe('mediaAsset');
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0]).toMatchObject({ root: '/media', key: 'media-1' });
    expect(jobs).toEqual([{ kind: 'media-ingest', idempotencyKey: 'media-ingest:media-1', payload: { assetId: 'media-1' } }]);
    expect(await media.inspect(ADMIN, 'media-1')).toEqual(uploaded);
    expect(await media.list(ADMIN)).toEqual([uploaded]);
  });

  it('archives and restores an asset without changing its manifest or stored bytes', async () => {
    const { db, io, media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png() });
    const archived = await media.archive(ADMIN, uploaded.stamp.id);
    expect(archived?.stamp.archivedAt).toBeDefined();
    expect(archived?.manifest).toEqual(uploaded.manifest);
    const restored = await media.restore(ADMIN, uploaded.stamp.id);
    expect(restored?.stamp.archivedAt).toBeUndefined();
    expect(restored?.manifest).toEqual(uploaded.manifest);
    expect(io.writes).toHaveLength(1);
    expect(db.rows.get(RECORDS.mediaAssets.collection)).toHaveLength(3);
  });

  it('rejects unsupported content before writing bytes or a manifest', async () => {
    const { db, io, media } = store();
    const error = await refused(media.upload(ADMIN, { bytes: new TextEncoder().encode('plain text'), name: 'photo.png', type: 'image/png' }));
    expect(error.name).toBe('MediaError');
    expect(error.kind).toBe('invalid-type');
    expect(io.writes).toEqual([]);
    expect(db.rows.get(RECORDS.mediaAssets.collection) ?? []).toEqual([]);
  });

  it('rejects duplicate bytes with an identifiable refusal', async () => {
    const { io, jobs, media } = store();
    await media.upload(ADMIN, { bytes: png() });
    const error = await refused(media.upload(ADMIN, { bytes: png() }));
    expect(error.kind).toBe('duplicate');
    expect(io.writes).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('refuses the write it loses the race for, which is what the standing sequence stays right', async () => {
    const { db, media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png() });
    // What a real race looks like from here: the ordinal was free when it was read and taken by the time
    // it was written, which only the unique index on (assetId, sequence) can notice.
    db.failOn = (): Error => Object.assign(new Error(`E11000 duplicate key: ${uploaded.stamp.id}#2`), { code: 11_000 });

    const error = await refused(media.archive(ADMIN, uploaded.stamp.id));
    expect(error.kind).toBe('duplicate');
    expect(db.rows.get(RECORDS.mediaAssets.collection)).toHaveLength(1);
  });
});

describe('processing state transitions', () => {
  it('starts and completes a processing cycle, and no-ops on a repeated start', async () => {
    const { media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png() });
    const id = uploaded.stamp.id;

    const started = await media.startProcessing(ADMIN, id);
    expect(started?.manifest).toMatchObject({ processingState: 'processing', derivatives: [] });
    expect((await media.startProcessing(ADMIN, id))?.manifest.processingState).toBe('processing');

    const derivative = { kind: 'source', bytes: uploaded.manifest.bytes, hash: uploaded.manifest.hash, from: id };
    const ready = await media.completeProcessing(ADMIN, id, [derivative]);
    expect(ready?.manifest).toMatchObject({ processingState: 'ready', derivatives: [derivative] });
    expect((await media.startProcessing(ADMIN, id))?.manifest.processingState).toBe('ready');
  });

  it('fails a processing attempt and lets an operator retry it back to pending', async () => {
    const { media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png() });
    const id = uploaded.stamp.id;
    await media.startProcessing(ADMIN, id);

    const failed = await media.failProcessing(ADMIN, id);
    expect(failed?.manifest).toMatchObject({ processingState: 'failed', derivatives: [] });

    const retried = await media.retryProcessing(ADMIN, id);
    expect(retried?.manifest).toMatchObject({ processingState: 'pending', derivatives: [] });
    expect((await media.startProcessing(ADMIN, id))?.manifest.processingState).toBe('processing');
  });

  it('refuses a processing transition made from the wrong state', async () => {
    const { media } = store();
    const uploaded = await media.upload(ADMIN, { bytes: png() });
    const id = uploaded.stamp.id;

    expect((await refused(media.completeProcessing(ADMIN, id, []))).kind).toBe('state');
    expect((await refused(media.failProcessing(ADMIN, id))).kind).toBe('state');
    expect((await refused(media.retryProcessing(ADMIN, id))).kind).toBe('state');

    await media.startProcessing(ADMIN, id);
    await media.failProcessing(ADMIN, id);
    expect((await refused(media.startProcessing(ADMIN, id))).kind).toBe('state');
  });

  it('answers undefined for a processing call against an asset that does not exist', async () => {
    const { media } = store();
    expect(await media.startProcessing(ADMIN, 'ghost')).toBeUndefined();
    expect(await media.completeProcessing(ADMIN, 'ghost', [])).toBeUndefined();
    expect(await media.failProcessing(ADMIN, 'ghost')).toBeUndefined();
    expect(await media.retryProcessing(ADMIN, 'ghost')).toBeUndefined();
  });
});
