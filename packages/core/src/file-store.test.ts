import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileStore } from './file-store.js';
import { HolyDeckError } from './messages.js';
import { appendRevision, createEmptyStoreFile } from './storage.js';
import type { TranslationStoreFile } from './storage.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

let dir: string;
let store: FileStore;
let tick = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holydeck-store-'));
  tick = 0;
  store = new FileStore(dir, {
    now: () => `2026-09-07T10:00:0${(tick += 1) % 10}.000Z`,
    lockTimeoutMs: 300,
    lockPollMs: 20,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('load/save', () => {
  it('returns undefined for a missing translation', async () => {
    expect(await store.load('KJV')).toBeUndefined();
  });

  it('round-trips a store file and stamps updatedAt on save', async () => {
    const file = createEmptyStoreFile('KJV', 'initial');
    await store.save('KJV', file);
    const loaded = await store.load('kjv');
    expect(loaded?.translation).toBe('KJV');
    expect(loaded?.updatedAt).not.toBe('initial');
  });

  it('throws store_corrupt on invalid JSON', async () => {
    mkdirSync(join(dir, 'bibles'), { recursive: true });
    writeFileSync(store.translationPath('KJV'), 'not json');
    await expect(store.load('KJV')).rejects.toMatchObject({ code: 'store_corrupt' });
  });

  it('rethrows non-ENOENT filesystem errors', async () => {
    mkdirSync(store.translationPath('KJV'), { recursive: true }); // a DIRECTORY at the file path → EISDIR
    await expect(store.load('KJV')).rejects.toThrowError();
    await expect(store.load('KJV')).rejects.not.toBeInstanceOf(HolyDeckError);
  });
});

describe('putChapter', () => {
  it('creates the file on first write and dedups unchanged content', async () => {
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

describe('translation abbr validation', () => {
  it('rejects a traversal abbr in translationPath', () => {
    try {
      store.translationPath('../../etc/passwd');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('invalid_translation');
    }
  });

  it('rejects a traversal abbr before it can touch the filesystem via putChapter', async () => {
    await expect(store.putChapter('../../etc/passwd', 'PSA', '117', { '1': 'A' }, 1)).rejects.toMatchObject({
      code: 'invalid_translation',
    });
  });

  it.each(['KJV', 'SCH2000', 'NR06', 'TAOVBSI'])('leaves a valid registry abbr %s unaffected', async (abbr) => {
    expect(await store.load(abbr)).toBeUndefined();
    expect(store.translationPath(abbr)).toContain(`${abbr}.json`);
  });
});

describe('withLock', () => {
  it('serializes concurrent critical sections', async () => {
    const order: string[] = [];
    await Promise.all([
      store.withLock('KJV', async () => {
        order.push('a-in');
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push('a-out');
      }),
      store.withLock('KJV', async () => {
        order.push('b-in');
        order.push('b-out');
      }),
    ]);
    expect(order.join(',')).toMatch(/^(a-in,a-out,b-in,b-out|b-in,b-out,a-in,a-out)$/);
  });

  it('times out with store_locked when the lock is held', async () => {
    const lockPath = join(dir, 'bibles', '.KJV.lock');
    mkdirSync(join(dir, 'bibles'), { recursive: true });
    writeFileSync(lockPath, '99999');
    await expect(store.withLock('KJV', async () => 'never')).rejects.toMatchObject({ code: 'store_locked' });
  });

  it('breaks a stale lock', async () => {
    const lockPath = join(dir, 'bibles', '.KJV.lock');
    mkdirSync(join(dir, 'bibles'), { recursive: true });
    writeFileSync(lockPath, '99999');
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath, past, past);
    expect(await store.withLock('KJV', async () => 'ran')).toBe('ran');
  });

  it('releases the lock even when fn throws', async () => {
    await expect(store.withLock('KJV', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await store.withLock('KJV', async () => 'ran-after')).toBe('ran-after');
  });

  it('rethrows non-EEXIST errors while acquiring the lock', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const openSpy = vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(error as never);
    await expect(store.withLock('KJV', async () => 'never')).rejects.toBe(error);
    openSpy.mockRestore();
  });

  it('tolerates the lock file vanishing between the EEXIST check and stat', async () => {
    const lockPath = join(dir, 'bibles', '.KJV.lock');
    mkdirSync(join(dir, 'bibles'), { recursive: true });
    writeFileSync(lockPath, '99999');
    const error = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const statSpy = vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(error as never);
    await expect(store.withLock('KJV', async () => 'never')).rejects.toMatchObject({ code: 'store_locked' });
    statSpy.mockRestore();
  });

  it('tolerates a stale lock disappearing before it can be unlinked', async () => {
    const lockPath = join(dir, 'bibles', '.KJV.lock');
    mkdirSync(join(dir, 'bibles'), { recursive: true });
    writeFileSync(lockPath, '99999');
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath, past, past);
    const error = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockRejectedValueOnce(error as never);
    expect(await store.withLock('KJV', async () => 'ran')).toBe('ran');
    unlinkSpy.mockRestore();
  });

  it('does not fail when releasing the lock errors', async () => {
    const error = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockRejectedValueOnce(error as never);
    expect(await store.withLock('KJV', async () => 'ran')).toBe('ran');
    unlinkSpy.mockRestore();
  });

  it('refreshes a held lock so a competing withLock waits instead of stealing it as stale', async () => {
    const refreshingStore = new FileStore(dir, {
      lockTimeoutMs: 5000,
      lockPollMs: 20,
      staleLockMs: 120,
    });
    const order: string[] = [];
    await Promise.all([
      refreshingStore.withLock('KJV', async () => {
        order.push('a-in');
        await new Promise((resolve) => setTimeout(resolve, 350));
        order.push('a-out');
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        order.push('b-in');
        await refreshingStore.withLock('KJV', async () => {
          order.push('b-run');
        });
      })(),
    ]);
    expect(order).toEqual(['a-in', 'b-in', 'a-out', 'b-run']);
  });

  it('tolerates a lock refresh failing because the lock file vanished mid-hold', async () => {
    const utimesSpy = vi
      .spyOn(fsPromises, 'utimes')
      .mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    const refreshingStore = new FileStore(dir, { lockTimeoutMs: 2000, lockPollMs: 20, staleLockMs: 60 });
    const result = await refreshingStore.withLock('KJV', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'ok';
    });
    expect(result).toBe('ok');
    utimesSpy.mockRestore();
  });
});

describe('FileStore defaults', () => {
  it('falls back to a real clock when no now() is injected', async () => {
    const defaultStore = new FileStore(dir);
    const file = createEmptyStoreFile('KJV', 'initial');
    await defaultStore.save('KJV', file);
    expect(file.updatedAt).not.toBe('initial');
    expect(new Date(file.updatedAt).toString()).not.toBe('Invalid Date');
  });
});

describe('importFile', () => {
  function fileWith(revTexts: string[], translation = 'KJV'): TranslationStoreFile {
    const file = createEmptyStoreFile(translation, 't0');
    let record;
    for (const [index, text] of revTexts.entries()) {
      record = appendRevision(record, { '1': text }, 1, `t${index + 1}`).record;
    }
    file.books.PSA = { chapters: { '117': record! } };
    return file;
  }

  it('adds whole chapters that are missing locally', async () => {
    const result = await store.importFile('KJV', fileWith(['A', 'B']));
    expect(result).toEqual({ newChapters: 1, addedRevisions: 2 });
    expect((await store.load('KJV'))?.books.PSA?.chapters['117']?.revisions).toHaveLength(2);
  });

  it('unions by contentHash: known content is skipped, new content appended with fresh rev numbers', async () => {
    await store.importFile('KJV', fileWith(['A', 'B']));
    const result = await store.importFile('KJV', fileWith(['A', 'C']));
    expect(result).toEqual({ newChapters: 0, addedRevisions: 1 });
    const record = (await store.load('KJV'))?.books.PSA?.chapters['117'];
    expect(record?.revisions.map((revision) => revision.rev)).toEqual([1, 2, 3]);
    expect(record?.revisions[2]?.verses['1']).toBe('C');
  });

  it('adopts incoming meta/canon when the incoming metadataBuild is not older', async () => {
    const incoming = fileWith(['A']);
    incoming.meta = { id: 1, abbreviation: 'KJV', localAbbreviation: 'KJV', title: 'T', localTitle: 'T',
      language: { iso6393: 'eng', name: 'English', localName: 'English', textDirection: 'ltr', languageTag: 'eng' },
      metadataBuild: 51 };
    incoming.canon = { books: [] };
    await store.importFile('KJV', incoming);
    expect((await store.load('KJV'))?.meta?.metadataBuild).toBe(51);

    const older = fileWith(['Z']);
    older.meta = { ...incoming.meta, metadataBuild: 3 };
    await store.importFile('KJV', older);
    expect((await store.load('KJV'))?.meta?.metadataBuild).toBe(51);
  });

  it('adopts incoming meta without touching canon when incoming has no canon', async () => {
    const incoming = fileWith(['A']);
    incoming.meta = { id: 1, abbreviation: 'KJV', localAbbreviation: 'KJV', title: 'T', localTitle: 'T',
      language: { iso6393: 'eng', name: 'English', localName: 'English', textDirection: 'ltr', languageTag: 'eng' },
      metadataBuild: 51 };
    await store.importFile('KJV', incoming);
    const loaded = await store.load('KJV');
    expect(loaded?.meta?.metadataBuild).toBe(51);
    expect(loaded?.canon).toBeUndefined();
  });
});
