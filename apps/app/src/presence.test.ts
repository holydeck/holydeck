import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  DEFAULT_PRESENCE_MS,
  PRESENCE_ACTIONS,
  PRESENCE_COLLECTION,
  PRESENCE_INDEXES,
  PRESENCE_PERMISSIONS,
  PresenceError,
  createPresenceIndexOn,
  dropPresenceIndexOn,
  editorPresence,
  entryFrom,
  livingFilter,
  presenceDb,
  presenceExpiry,
  presenceOn,
  presencePrivileges,
} from './presence.js';
import { memoryPresence } from '../test/helpers/presence.js';

import type { Db } from 'mongodb';
import type { PresenceStore } from './presence.js';

const CORRELATION = 'req-0f9c2a41';
const ADA = 'account:7f3a';
const GRACE = 'account:b2c9';
const SONG = 'song-1';

let clock = Date.parse('2026-09-17T09:30:00.000Z');
let memory: ReturnType<typeof memoryPresence>;
let store: PresenceStore;

const now = (): string => new Date(clock).toISOString();

const as = (actor: string): unknown => editorPresence(actor, CORRELATION);

beforeEach(() => {
  clock = Date.parse('2026-09-17T09:30:00.000Z');
  memory = memoryPresence();
  store = presenceOn(memory.db, { now });
});

describe('what presence owns', () => {
  test('names the collection it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(PRESENCE_COLLECTION).toBe('presence');
    expect(PRESENCE_PERMISSIONS).toEqual({ enter: 'presence.enter', read: 'presence.read' });
    expect(presencePrivileges()).toEqual({ collection: PRESENCE_COLLECTION, actions: PRESENCE_ACTIONS });
    expect(PRESENCE_ACTIONS).toContain('update');
  });

  test('declares one index, over fields an entry carries and with no sweep attached to it', () => {
    expect(PRESENCE_INDEXES).toEqual([
      { name: 'presence_live', keys: { contentId: 1, expiresAt: 1, enteredAt: 1 }, options: {} },
    ]);
    expect(PRESENCE_INDEXES[0]?.options).not.toHaveProperty('expireAfterSeconds');
  });

  test('touches its own collection and no other', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    await store.list(as(ADA), SONG);
    await store.leave(as(ADA), { contentId: SONG });
    expect(new Set(memory.names)).toEqual(new Set([PRESENCE_COLLECTION]));
  });
});

// The whole of COLL-01's "without hard locks": there is no lock to take, so a second editor is never
// turned away and the first one is never told to wait.
describe('two editors on one piece of content', () => {
  test('both enter, both are listed, and neither is refused for the other being there', async () => {
    const first = await store.enter(as(ADA), { contentId: SONG });
    const second = await store.enter(as(GRACE), { contentId: SONG });

    expect(first.actor).toBe(ADA);
    expect(second.actor).toBe(GRACE);
    expect((await store.list(as(ADA), SONG)).map((entry) => entry.actor)).toEqual([ADA, GRACE]);
  });

  test('is one entry each rather than one entry contested, so neither overwrites the other', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    clock += 1_000;
    await store.enter(as(GRACE), { contentId: SONG });
    expect(memory.rows.size).toBe(2);

    const [ada, grace] = await store.list(as(ADA), SONG);
    expect(ada?.enteredAt).toBe('2026-09-17T09:30:00.000Z');
    expect(grace?.enteredAt).toBe('2026-09-17T09:30:01.000Z');
  });

  test('leaves each other alone: one leaving takes nobody else’s entry with it', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    await store.enter(as(GRACE), { contentId: SONG });

    expect(await store.leave(as(ADA), { contentId: SONG })).toBe(true);
    expect((await store.list(as(GRACE), SONG)).map((entry) => entry.actor)).toEqual([GRACE]);
  });

  test('is content by content, so entering one does not put anybody in another', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    await store.enter(as(GRACE), { contentId: 'song-2' });
    expect((await store.list(as(ADA), SONG)).map((entry) => entry.actor)).toEqual([ADA]);
  });
});

describe('entering and staying', () => {
  test('records when the editor arrived, when they were last heard from, and when they stop counting', async () => {
    const entry = await store.enter(as(ADA), { contentId: SONG });
    expect(entry).toEqual({
      contentId: SONG,
      actor: ADA,
      enteredAt: '2026-09-17T09:30:00.000Z',
      heartbeatAt: '2026-09-17T09:30:00.000Z',
      expiresAt: new Date(clock + DEFAULT_PRESENCE_MS).toISOString(),
    });
  });

  test('keeps the instant somebody actually arrived when they are still here, and moves the rest', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    clock += 5_000;
    const again = await store.enter(as(ADA), { contentId: SONG });

    expect(again.enteredAt).toBe('2026-09-17T09:30:00.000Z');
    expect(again.heartbeatAt).toBe('2026-09-17T09:30:05.000Z');
    expect(again.expiresAt).toBe(new Date(clock + DEFAULT_PRESENCE_MS).toISOString());
    expect(memory.rows.size).toBe(1);
  });

  test('is an arrival rather than a refresh once the entry has run out', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    clock += DEFAULT_PRESENCE_MS + 1_000;
    const returned = await store.enter(as(ADA), { contentId: SONG });
    expect(returned.enteredAt).toBe(now());
  });

  test('holds an entry for as long as the store was told to, when it was told something else', async () => {
    const brief = presenceOn(memory.db, { now, presenceMs: 5_000 });
    const entry = await brief.enter(as(ADA), { contentId: SONG });
    expect(entry.expiresAt).toBe(new Date(clock + 5_000).toISOString());
  });
});

describe('who is still here', () => {
  test('is everyone whose entry has not run out, decided by the reader’s clock', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    clock += 10_000;
    await store.enter(as(GRACE), { contentId: SONG });

    clock += DEFAULT_PRESENCE_MS - 5_000;
    expect((await store.list(as(ADA), SONG)).map((entry) => entry.actor)).toEqual([GRACE]);

    clock += 10_000;
    expect(await store.list(as(ADA), SONG)).toEqual([]);
  });

  test('filters on the expiry itself, which is what the entry says and not what a sweep got to', () => {
    expect(livingFilter(SONG, now())).toEqual({ contentId: SONG, expiresAt: { $gt: now() } });
  });

  test('is read without the right to be seen, and only with the right to see', async () => {
    const seen = requestContext({ actor: ADA, permissions: [PRESENCE_PERMISSIONS.enter], correlationId: CORRELATION });
    const refused = await store.list(seen, SONG).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PresenceError);
    expect(refused).toMatchObject({ kind: 'permission' });
    expect(String(refused)).toContain(PRESENCE_PERMISSIONS.read);
  });
});

describe('leaving', () => {
  test('takes the entry away, so the editor stops being listed at once rather than in half a minute', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    expect(await store.leave(as(ADA), { contentId: SONG })).toBe(true);
    expect(await store.list(as(ADA), SONG)).toEqual([]);
  });

  test('answers false when there was nothing to leave', async () => {
    expect(await store.leave(as(ADA), { contentId: SONG })).toBe(false);
  });
});

describe('what presence refuses', () => {
  test('a context it cannot read, and an actor who may not be seen', async () => {
    await expect(store.enter({}, { contentId: SONG })).rejects.toMatchObject({ kind: 'context' });

    const reader = requestContext({ actor: ADA, permissions: [PRESENCE_PERMISSIONS.read], correlationId: CORRELATION });
    await expect(store.enter(reader, { contentId: SONG })).rejects.toMatchObject({ kind: 'permission' });
    await expect(store.leave(reader, { contentId: SONG })).rejects.toMatchObject({ kind: 'permission' });
  });

  test('a content identifier carrying the separator, which would name another editor’s entry', async () => {
    const hostile = { contentId: `${SONG}#${GRACE}` };
    await expect(store.enter(as(ADA), hostile)).rejects.toMatchObject({ kind: 'schema' });
    await expect(store.list(as(ADA), hostile.contentId)).rejects.toMatchObject({ kind: 'schema' });
    await expect(store.leave(as(ADA), hostile)).rejects.toMatchObject({ kind: 'schema' });
  });

  test('a clock writing an instant the database could not compare as text', async () => {
    const loose = presenceOn(memory.db, { now: () => '2026-09-17T09:30:00Z' });
    await expect(loose.enter(as(ADA), { contentId: SONG })).rejects.toMatchObject({ kind: 'schema' });
    expect(() => presenceExpiry('later', DEFAULT_PRESENCE_MS)).toThrow(PresenceError);
  });

  test('an entry it cannot read back, rather than serving it', () => {
    expect(() => entryFrom({ _id: `${SONG}#${ADA}`, contentId: SONG })).toThrow(PresenceError);
  });

  test('an entry stored under a key that is not the pair it claims to be', async () => {
    await store.enter(as(ADA), { contentId: SONG });
    const row = memory.rows.get(`${SONG}#${ADA}`) ?? {};
    memory.rows.set(`${SONG}#${GRACE}`, { ...row, _id: `${SONG}#${GRACE}` });
    await expect(store.list(as(ADA), SONG)).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('the indexes presence is read by', () => {
  test('are built and dropped by the names presence declares, and by no other', async () => {
    const [index] = PRESENCE_INDEXES;
    expect(await createPresenceIndexOn(memory.db, index!)).toBe(index?.name);
    expect(memory.indexes).toEqual([index?.name]);

    await dropPresenceIndexOn(memory.db, index!.name);
    expect(memory.indexes).toEqual([]);
  });

  test('are only the declared ones, and only over fields an entry carries', () => {
    expect(() => createPresenceIndexOn(memory.db, { name: 'invented', keys: { contentId: 1 }, options: {} })).toThrow(
      'invented',
    );
    expect(() => dropPresenceIndexOn(memory.db, 'invented')).toThrow(PresenceError);
    expect(() => createPresenceIndexOn(memory.db, { name: 'presence_live', keys: { editing: 1 }, options: {} })).toThrow(
      'editing',
    );
    expect(memory.indexes).toEqual([]);
  });
});

describe('presence over a real database', () => {
  test('reaches the collection it declares, through the driver it was handed', () => {
    const asked: string[] = [];
    const driver = { collection: (name: string) => (asked.push(name), {}) } as unknown as Db;
    presenceDb(driver).collection(PRESENCE_COLLECTION);
    expect(asked).toEqual([PRESENCE_COLLECTION]);
  });
});
