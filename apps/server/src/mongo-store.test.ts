import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyStoreFile } from '@holydeck/core/storage';
import { MongoStore } from './mongo-store.js';
import { startTestMongo } from '../test/helpers/mongo.js';
import type { SyncStore } from '@holydeck/core/sync';
import type { TestMongo } from '../test/helpers/mongo.js';

let mongo: TestMongo;
let store: MongoStore;
let tick = 0;

beforeAll(async () => {
  mongo = await startTestMongo();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  tick = 0;
  store = new MongoStore(mongo.db, {
    now: () => `2026-09-08T10:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`,
    lockTimeoutMs: 100,
  });
});

describe('load/save', () => {
  it('returns undefined for a missing translation', async () => {
    expect(await store.load('KJV')).toBeUndefined();
  });

  it('round-trips a store file, uppercases the key and stamps updatedAt on save', async () => {
    const file = createEmptyStoreFile('KJV', 'initial');
    await store.save('kjv', file);
    const loaded = await store.load('kJv');
    expect(loaded?.translation).toBe('KJV');
    expect(loaded?.updatedAt).toBe('2026-09-08T10:00:01.000Z');
    expect(loaded).not.toHaveProperty('_id');
  });

  it('throws store_corrupt with a mongo pseudo-path on an invalid document', async () => {
    await mongo.db.collection('translations').insertOne({ _id: 'BAD' as never, nope: true });
    await expect(store.load('bad')).rejects.toMatchObject({
      code: 'store_corrupt',
      params: expect.objectContaining({ path: 'mongo:translations/BAD' }) as object,
    });
  });

  it('loadAll returns every translation sorted by abbreviation', async () => {
    await store.save('NIV', createEmptyStoreFile('NIV', 'x'));
    await store.save('KJV', createEmptyStoreFile('KJV', 'x'));
    const all = await store.loadAll();
    expect(all.map((file) => file.translation)).toEqual(['KJV', 'NIV']);
    expect(all[0]).not.toHaveProperty('_id');
  });

  it('loadAll returns an empty array on an empty database', async () => {
    expect(await store.loadAll()).toEqual([]);
  });
});

describe('putChapter', () => {
  it('creates the document on first write and dedups unchanged content (same semantics as FileStore)', async () => {
    const first = await store.putChapter('KJV', 'PSA', '117', { '1': 'A', '2': 'B' }, 2);
    expect(first).toEqual({ changed: true, rev: 1 });
    const second = await store.putChapter('KJV', 'PSA', '117', { '1': 'A', '2': 'B' }, 2);
    expect(second).toEqual({ changed: false, rev: 1 });
    const third = await store.putChapter('KJV', 'PSA', '117', { '1': 'A!', '2': 'B' }, 2);
    expect(third).toEqual({ changed: true, rev: 2 });
    const loaded = await store.load('KJV');
    expect(loaded?.books.PSA?.chapters['117']?.revisions).toHaveLength(2);
  });
});

describe('withLock', () => {
  it('serializes concurrent critical sections per translation', async () => {
    const order: string[] = [];
    await Promise.all([
      store.withLock('KJV', async () => {
        order.push('a-in');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('a-out');
      }),
      store.withLock('KJV', async () => {
        order.push('b-in');
        order.push('b-out');
      }),
    ]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('does not serialize different translations against each other', async () => {
    const order: string[] = [];
    let releaseKjv!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseKjv = resolve;
    });
    const kjv = store.withLock('KJV', async () => {
      order.push('kjv-in');
      await gate;
      order.push('kjv-out');
    });
    await store.withLock('NIV', async () => {
      order.push('niv');
    });
    releaseKjv();
    await kjv;
    expect(order).toEqual(['kjv-in', 'niv', 'kjv-out']);
  });

  it('times out with store_locked and leaves the queue usable afterwards', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.withLock('KJV', async () => {
      await gate;
      return 'first';
    });
    await expect(store.withLock('KJV', async () => 'second')).rejects.toMatchObject({
      code: 'store_locked',
      params: { abbr: 'KJV', path: 'memory:KJV' },
    });
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(store.withLock('KJV', async () => 'third')).resolves.toBe('third');
  });

  it('propagates errors from the critical section and still releases the lock', async () => {
    await expect(
      store.withLock('KJV', async () => {
        throw new Error('inner failure');
      }),
    ).rejects.toThrowError('inner failure');
    await expect(store.withLock('KJV', async () => 'after')).resolves.toBe('after');
  });
});

describe('defaults and connectivity', () => {
  it('uses a real ISO clock and default lock timeout when constructed without options', async () => {
    const dedicated = await startTestMongo();
    const plain = new MongoStore(dedicated.db);
    expect(plain.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(await plain.ping()).toBe(true);
    await dedicated.stop();
    expect(await plain.ping()).toBe(false);
  });

  it('is assignable to core SyncStore (compile-time check)', () => {
    const asSyncStore: SyncStore = store;
    expect(typeof asSyncStore.putChapterInFile).toBe('function');
  });
});
