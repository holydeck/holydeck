import { describe, expect, test } from 'vitest';

import { mediaContext, mediaLibraryOn } from '@holydeck/app/media';

import { mediaIngestOn } from './media-ingest.js';
import { runnerOn } from './runner.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { LeasedJob } from '@holydeck/contracts/jobs';
import type { MediaLibrary, MediaStorageIO } from '@holydeck/app/media';
import type { RunnerQueue } from './runner.js';

const CONTEXT = mediaContext('system', 'media-worker-test');
const NOW = '2026-09-17T09:30:00.000Z';

const png = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const mp4 = (): Uint8Array => new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);

const job = (assetId: string, fields: Partial<LeasedJob> = {}): LeasedJob => ({
  id: 'job-1',
  kind: 'media-ingest',
  idempotencyKey: `media-ingest:${assetId}`,
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-17T09:31:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  ...fields,
  payload: fields.payload ?? { assetId },
});

const open = (): { media: MediaLibrary; storage: MediaStorageIO; writes: Array<{ key: string; bytes: Uint8Array }> } => {
  const bytes = new Map<string, Uint8Array>();
  const writes: Array<{ key: string; bytes: Uint8Array }> = [];
  const storage: MediaStorageIO = {
    async write(root, key, value) {
      const handle = `${root}/${key}`;
      bytes.set(handle, value);
      writes.push({ key, bytes: value });
      return handle;
    },
    async read(_root, key) {
      const value = bytes.get(key);
      if (value === undefined) throw new Error(`${key} is unreadable`);
      return value;
    },
  };
  let serial = 0;
  return {
    storage,
    writes,
    media: mediaLibraryOn(fakeDb(), {
      now: () => NOW,
      newId: () => `media-${(serial += 1)}`,
      mediaRoot: '/media',
      ...storage,
      queue: { async enqueue() { return { id: 'job-1', created: true }; } },
    }),
  };
};

describe('media ingestion', () => {
  test('probes compatible bytes before transcoding and preserves their hash as the source derivative', async () => {
    const world = open();
    const uploaded = await world.media.upload(CONTEXT, { bytes: png() });
    const handler = mediaIngestOn({
      context: CONTEXT,
      media: world.media,
      storage: world.storage,
      mediaRoot: '/media',
      poster: { async generate() { throw new Error('a non-video does not need a poster'); } },
    });

    await handler(job(uploaded.stamp.id), new AbortController().signal);

    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({
      processingState: 'ready',
      derivatives: [{ kind: 'source', hash: uploaded.manifest.hash, from: uploaded.stamp.id }],
    });
    expect(world.writes).toHaveLength(1);

    await handler(job(uploaded.stamp.id), new AbortController().signal);
    expect(world.writes).toHaveLength(1);
  });

  test('refuses to complete when the stored bytes no longer match the asset’s recorded hash', async () => {
    const world = open();
    const uploaded = await world.media.upload(CONTEXT, { bytes: png() });
    const corrupted = png();
    corrupted[corrupted.length - 1] = 0xff;
    await world.storage.write('/media', uploaded.stamp.id, corrupted);
    const handler = mediaIngestOn({
      context: CONTEXT,
      media: world.media,
      storage: world.storage,
      mediaRoot: '/media',
      poster: { async generate() { throw new Error('a non-video does not need a poster'); } },
    });

    await expect(handler(job(uploaded.stamp.id, { attempt: 2, retryLimit: 2 }), new AbortController().signal)).rejects.toThrow(
      'no longer match its recorded hash',
    );
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({ processingState: 'failed', derivatives: [] });
  });

  test('keeps automatic retries processing, records terminal poster failure, and reprocesses an operator requeue', async () => {
    const world = open();
    const uploaded = await world.media.upload(CONTEXT, { bytes: mp4() });
    let failed = true;
    const handler = mediaIngestOn({
      context: CONTEXT,
      media: world.media,
      storage: world.storage,
      mediaRoot: '/media',
      poster: { async generate() { return failed ? undefined : new Uint8Array([1, 2, 3]); } },
    });

    await expect(handler(job(uploaded.stamp.id), new AbortController().signal)).rejects.toThrow('no static poster');
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({ processingState: 'processing', derivatives: [] });

    await expect(handler(job(uploaded.stamp.id, { attempt: 2 }), new AbortController().signal)).rejects.toThrow('no static poster');
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({ processingState: 'failed', derivatives: [] });

    failed = false;
    await handler(job(uploaded.stamp.id), new AbortController().signal);
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({
      processingState: 'ready',
      derivatives: [{ kind: 'source' }, { kind: 'poster' }],
    });
  });

  test('leaving a lease during poster extraction appends no partial derivative', async () => {
    const world = open();
    const uploaded = await world.media.upload(CONTEXT, { bytes: mp4() });
    let release!: (value: Uint8Array) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handler = mediaIngestOn({
      context: CONTEXT,
      media: world.media,
      storage: world.storage,
      mediaRoot: '/media',
      poster: {
        async generate() {
          entered();
          return new Promise<Uint8Array>((resolve) => {
            release = resolve;
          });
        },
      },
    });
    let claimed = false;
    const queue: RunnerQueue = {
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return job(uploaded.stamp.id);
      },
      async heartbeat() {
        return false;
      },
      async succeed() {
        throw new Error('the lost lease must not succeed');
      },
      async fail() {
        throw new Error('the lost lease must not fail');
      },
      async recover() {
        return [];
      },
    };
    let beat!: () => void;
    const runner = runnerOn({
      queue,
      context: CONTEXT,
      worker: 'worker-1',
      handlers: { 'media-ingest': handler },
      now: () => NOW,
      sleep: async () => undefined,
      ticker: (_everyMs, tick) => {
        beat = tick;
        return (): void => undefined;
      },
      report: () => undefined,
    });
    const running = runner.once();
    await started;
    beat();
    release(new Uint8Array([1, 2, 3]));

    await expect(running).resolves.toBe('lost');
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({ processingState: 'processing', derivatives: [] });
    expect(world.writes).toHaveLength(1);
  });

  test('losing the lease on the exhausted attempt still records the terminal failure', async () => {
    const world = open();
    const uploaded = await world.media.upload(CONTEXT, { bytes: mp4() });
    let release!: (value: Uint8Array) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handler = mediaIngestOn({
      context: CONTEXT,
      media: world.media,
      storage: world.storage,
      mediaRoot: '/media',
      poster: {
        async generate() {
          entered();
          return new Promise<Uint8Array>((resolve) => {
            release = resolve;
          });
        },
      },
    });
    let claimed = false;
    const queue: RunnerQueue = {
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return job(uploaded.stamp.id, { attempt: 2, retryLimit: 2 });
      },
      async heartbeat() {
        return false;
      },
      async succeed() {
        throw new Error('the lost lease must not succeed');
      },
      async fail() {
        throw new Error('the lost lease must not fail');
      },
      async recover() {
        return [];
      },
    };
    let beat!: () => void;
    const runner = runnerOn({
      queue,
      context: CONTEXT,
      worker: 'worker-1',
      handlers: { 'media-ingest': handler },
      now: () => NOW,
      sleep: async () => undefined,
      ticker: (_everyMs, tick) => {
        beat = tick;
        return (): void => undefined;
      },
      report: () => undefined,
    });
    const running = runner.once();
    await started;
    beat();
    release(new Uint8Array([1, 2, 3]));

    await expect(running).resolves.toBe('lost');
    expect((await world.media.inspect(CONTEXT, uploaded.stamp.id))?.manifest).toMatchObject({ processingState: 'failed', derivatives: [] });
  });
});
