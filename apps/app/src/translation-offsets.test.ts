import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  TRANSLATION_OFFSET_COLLECTION,
  TRANSLATION_OFFSET_PERMISSIONS,
  TranslationOffsetError,
  translationOffsetDb,
  translationOffsetSystemContext,
  translationOffsetsOn,
} from './translation-offsets.js';
import { memoryTranslationOffsets } from '../test/helpers/translation-offsets.js';

import type { TranslationOffsetStore } from './translation-offsets.js';

const CORRELATION = 'req-0f9c2a41';

let store: TranslationOffsetStore;
let memory: ReturnType<typeof memoryTranslationOffsets>;

const context = (): unknown => translationOffsetSystemContext(CORRELATION);

beforeEach(() => {
  memory = memoryTranslationOffsets();
  store = translationOffsetsOn(memory.db);
});

describe('what the translation offset store owns', () => {
  test('names the collection it owns and the permission setting one is reached through', () => {
    expect(TRANSLATION_OFFSET_COLLECTION).toBe('translation_offsets');
    expect(TRANSLATION_OFFSET_PERMISSIONS).toEqual({ manage: 'translationOffsets.manage' });
  });

  test('setting one is reached under a context that is the product acting as itself, and under nothing else', async () => {
    await expect(store.set({}, 'KJV', 1)).rejects.toMatchObject({ kind: 'context' });

    const bystander = requestContext({ actor: 'account:7f3a', permissions: [], correlationId: CORRELATION });
    const refused = await store.set(bystander, 'KJV', 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TranslationOffsetError);
    expect(refused).toMatchObject({ kind: 'permission' });
    expect(String(refused)).toContain(TRANSLATION_OFFSET_PERMISSIONS.manage);
  });

  test('reading one back, or every one configured, asks the caller for nothing', async () => {
    await store.set(context(), 'KJV', 1);
    await expect(store.get('KJV')).resolves.toBe(1);
    await expect(store.list()).resolves.toEqual([{ abbr: 'KJV', offset: 1 }]);
  });

  test('touches its own collection and no other', async () => {
    await store.set(context(), 'KJV', 1);
    await store.get('KJV');
    await store.list();
    expect(new Set([...memory.rows.keys()])).toEqual(new Set(['KJV']));
  });
});

describe('reading a translation offset back', () => {
  test('answers zero for a translation nothing has ever configured', async () => {
    await expect(store.get('WEB')).resolves.toBe(0);
  });

  test('answers the offset most recently set, once one has been', async () => {
    await store.set(context(), 'KJV', 3);
    await expect(store.get('KJV')).resolves.toBe(3);
    await store.set(context(), 'KJV', -2);
    await expect(store.get('KJV')).resolves.toBe(-2);
  });
});

describe('configuring an offset', () => {
  test('accepts a negative offset, zero, and a positive one alike', async () => {
    expect(await store.set(context(), 'KJV', -5)).toEqual({ abbr: 'KJV', offset: -5 });
    expect(await store.set(context(), 'KJV', 0)).toEqual({ abbr: 'KJV', offset: 0 });
    expect(await store.set(context(), 'KJV', 5)).toEqual({ abbr: 'KJV', offset: 5 });
  });

  test('keeps one offset per translation, and no other translation is disturbed by it', async () => {
    await store.set(context(), 'KJV', 1);
    await store.set(context(), 'WEB', -1);
    await expect(store.get('KJV')).resolves.toBe(1);
    await expect(store.get('WEB')).resolves.toBe(-1);
  });

  test('refuses a blank translation abbreviation', async () => {
    const refused = await store.set(context(), '  ', 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TranslationOffsetError);
    expect(refused).toMatchObject({ kind: 'schema' });
  });

  test('refuses an offset that is not a whole number', async () => {
    const refused = await store.set(context(), 'KJV', 1.5).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TranslationOffsetError);
    expect(refused).toMatchObject({ kind: 'schema' });
  });
});

describe('listing every configured offset', () => {
  test('answers only the translations an offset has actually been set for', async () => {
    await store.set(context(), 'KJV', 1);
    expect(await store.list()).toEqual([{ abbr: 'KJV', offset: 1 }]);
  });

  test('answers nothing when nothing has been configured, not a default entry for every translation', async () => {
    expect(await store.list()).toEqual([]);
  });
});

describe('reaching the store over a real database handle', () => {
  test('asks the database for its own collection and nothing else', () => {
    const asked: string[] = [];
    const db = translationOffsetDb({
      collection: (name: string) => {
        asked.push(name);
        return {} as never;
      },
    } as never);
    db.collection(TRANSLATION_OFFSET_COLLECTION);
    expect(asked).toEqual([TRANSLATION_OFFSET_COLLECTION]);
  });
});
