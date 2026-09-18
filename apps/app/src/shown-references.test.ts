import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import {
  SHOWN_REFERENCE_COLLECTION,
  SHOWN_REFERENCE_PERMISSIONS,
  ShownReferenceError,
  shownReferenceContext,
  shownReferenceDb,
  shownReferencesOn,
} from './shown-references.js';
import { memoryShownReferences } from '../test/helpers/shown-references.js';

import type { Document } from './repositories.js';
import type { ShownReferenceStore } from './shown-references.js';

const OPERATOR = 'account:AAAAAAAAAAAAAAAAAAAAAA';
const CORRELATION = 'shown:req-1';
const NOW = '2026-09-16T19:05:00.000Z';

const GENESIS = { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1, 2] } as const;

const held = (): { store: ShownReferenceStore; rows: Document[]; names: string[] } => {
  const memory = memoryShownReferences();
  let tick = 0;
  let minted = 0;
  const store = shownReferencesOn(memory.db, {
    now: () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString(),
    newId: () => `s${minted++}`,
  });
  return { store, rows: memory.rows, names: memory.names };
};

const operating = shownReferenceContext(OPERATOR, CORRELATION);

describe('recording what an operator put in front of the room', () => {
  it('keeps the reference, the revision it was read at, the actor and when, in its own collection', async () => {
    const { store, rows, names } = held();
    const entry = await store.record(operating, { reference: GENESIS, revision: 3 });
    expect(entry).toEqual({ reference: GENESIS, revision: 3, actor: OPERATOR, recordedAt: NOW });
    expect(names).toContain(SHOWN_REFERENCE_COLLECTION);
    expect(rows).toHaveLength(1);
  });

  it('names the actor from the context it was called under, never from what the caller passed', async () => {
    const { store } = held();
    const entry = await store.record(
      shownReferenceContext('account:BBBBBBBBBBBBBBBBBBBBBB', CORRELATION),
      { reference: GENESIS, revision: 7 },
    );
    expect(entry.actor).toBe('account:BBBBBBBBBBBBBBBBBBBBBB');
  });

  it('refuses a context this code would not act under', async () => {
    const { store } = held();
    await expect(store.record({ actor: '' }, { reference: GENESIS, revision: 1 })).rejects.toMatchObject({
      name: 'ShownReferenceError',
      kind: 'context',
    });
  });

  it('refuses an actor who may read the log but not add to it', async () => {
    const { store } = held();
    const reader = requestContext({
      actor: OPERATOR,
      permissions: [SHOWN_REFERENCE_PERMISSIONS.read],
      correlationId: CORRELATION,
    });
    await expect(store.record(reader, { reference: GENESIS, revision: 1 })).rejects.toMatchObject({
      kind: 'permission',
    });
  });

  it('refuses a revision below the first one a library has', async () => {
    const { store } = held();
    await expect(store.record(operating, { reference: GENESIS, revision: 0 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a reference naming no translation, no book, no chapter or no verse at all', async () => {
    const { store } = held();
    const refusals = [
      { ...GENESIS, abbr: '  ' },
      { ...GENESIS, book: '' },
      { ...GENESIS, chapter: 0 },
      { ...GENESIS, verses: [] },
      { ...GENESIS, verses: [0] },
    ];
    for (const reference of refusals) {
      await expect(store.record(operating, { reference, revision: 1 })).rejects.toBeInstanceOf(ShownReferenceError);
    }
  });

  it('refuses a clock writing an instant the log could not be ordered by', async () => {
    const memory = memoryShownReferences();
    const store = shownReferencesOn(memory.db, { now: () => '2026-09-16T19:05:00Z', newId: () => 's1' });
    await expect(store.record(operating, { reference: GENESIS, revision: 1 })).rejects.toMatchObject({ kind: 'schema' });
    expect(memory.rows).toHaveLength(0);
  });
});

describe('reading back what was shown', () => {
  it('answers nothing before anything has been shown', async () => {
    const { store } = held();
    expect(await store.recent(operating)).toEqual([]);
  });

  it('answers the most recently shown first, whatever order the rows were written in', async () => {
    const { store } = held();
    await store.record(operating, { reference: GENESIS, revision: 3 });
    await store.record(operating, { reference: { ...GENESIS, chapter: 2, verses: [4] }, revision: 4 });
    const shown = await store.recent(operating);
    expect(shown.map((entry) => entry.reference.chapter)).toEqual([2, 1]);
    expect(shown.map((entry) => entry.revision)).toEqual([4, 3]);
  });

  it('answers no more than the caller asked for', async () => {
    const { store } = held();
    for (const chapter of [1, 2, 3]) await store.record(operating, { reference: { ...GENESIS, chapter }, revision: 1 });
    expect(await store.recent(operating, 2)).toHaveLength(2);
  });

  it('refuses an actor who may add to the log but not read it', async () => {
    const { store } = held();
    const writer = requestContext({
      actor: OPERATOR,
      permissions: [SHOWN_REFERENCE_PERMISSIONS.record],
      correlationId: CORRELATION,
    });
    await expect(store.recent(writer)).rejects.toMatchObject({ kind: 'permission' });
  });

  it('refuses a row it could not read back rather than serving one it cannot grade', async () => {
    const memory = memoryShownReferences();
    const store = shownReferencesOn(memory.db, { now: () => NOW, newId: () => 's1' });
    memory.rows.push({ _id: 's0', abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1], actor: OPERATOR, recordedAt: NOW });
    await expect(store.recent(operating)).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('the shape of the log itself', () => {
  // The one promise this provisional store does make: nothing it exposes changes or removes a row that
  // was written. A verb added here that did would be caught by this, not by a reviewer noticing.
  it('offers no way to change or remove a row once it is written', () => {
    const { store } = held();
    expect(Object.keys(store).toSorted()).toEqual(['recent', 'record']);
    expect(Object.isFrozen(store)).toBe(true);
  });
});

describe('reaching the log over a real database handle', () => {
  it('asks the database for its own collection and nothing else', () => {
    const asked: string[] = [];
    const db = shownReferenceDb({
      collection: (name: string) => {
        asked.push(name);
        return {} as never;
      },
    } as never);
    db.collection(SHOWN_REFERENCE_COLLECTION);
    expect(asked).toEqual([SHOWN_REFERENCE_COLLECTION]);
  });
});
