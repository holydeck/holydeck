import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { RECORDS, RECORD_NAMES } from './records.js';
import { RepositoryError, createIndexOn, dropIndexOn, repositoriesOn } from './repositories.js';

import type { RepositoryCollection, RepositoryDb } from './repositories.js';

interface Call {
  readonly collection: string;
  readonly method: string;
  readonly argument: unknown;
}

function fakeDb(rows: readonly Record<string, unknown>[] = [], fail?: unknown): { db: RepositoryDb; calls: Call[] } {
  const calls: Call[] = [];
  const db: RepositoryDb = {
    collection(name: string): RepositoryCollection {
      return {
        async insertOne(document) {
          calls.push({ collection: name, method: 'insertOne', argument: document });
          if (fail !== undefined) throw fail;
          return { insertedId: document['_id'] ?? 'generated-id' };
        },
        find(filter, options) {
          calls.push({ collection: name, method: 'find', argument: { filter, options } });
          return { toArray: async () => [...rows] };
        },
        async countDocuments(filter) {
          calls.push({ collection: name, method: 'countDocuments', argument: filter });
          return rows.length;
        },
        async createIndex(keys, options) {
          calls.push({ collection: name, method: 'createIndex', argument: { keys, options } });
          return 'index-name';
        },
        async dropIndex(index) {
          calls.push({ collection: name, method: 'dropIndex', argument: index });
        },
      };
    },
  };
  return { db, calls };
}

const OPERATOR = requestContext({
  actor: 'account:7f3a',
  permissions: ['runEvents.append', 'runEvents.read'],
  correlationId: 'req-0f9c2a41',
});

const EVENT = {
  runId: 'run:1',
  sequence: 1,
  at: '2026-09-13T09:00:00.000Z',
  kind: 'slide.shown',
  pinnedRevisions: { content: 'sha256:abc' },
  actor: OPERATOR.actor,
  correlationId: OPERATOR.correlationId,
};

const thrown = (call: () => unknown): RepositoryError => {
  try {
    call();
  } catch (error) {
    if (error instanceof RepositoryError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

const rejected = async (call: Promise<unknown>): Promise<RepositoryError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RepositoryError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('appending a durable record', () => {
  it('writes it to the collection its class names', async () => {
    const { db, calls } = fakeDb();
    const id = await repositoriesOn(db).runEvents.append(OPERATOR, EVENT);
    expect(id).toBe('generated-id');
    expect(calls).toEqual([{ collection: RECORDS.runEvents.collection, method: 'insertOne', argument: EVENT }]);
  });

  it('refuses a caller with no context at all, rather than reading one from anywhere else', async () => {
    const { db, calls } = fakeDb();
    const error = await rejected(repositoriesOn(db).runEvents.append(undefined, EVENT));
    expect(error.kind).toBe('context');
    expect(error.message).toBe('runEvents: context: expected an actor, permissions and a correlation identifier');
    expect(calls).toEqual([]);
  });

  it('refuses an actor the context does not permit to append', async () => {
    const { db } = fakeDb();
    const reader = requestContext({ ...OPERATOR, permissions: ['runEvents.read'] });
    const error = await rejected(repositoriesOn(db).runEvents.append(reader, EVENT));
    expect(error.kind).toBe('permission');
    expect(error.message).toBe('runEvents: the actor may not append, which needs runEvents.append');
  });

  it('refuses a field that would make the record tenant-scoped', async () => {
    const { db } = fakeDb();
    const error = await rejected(repositoriesOn(db).runEvents.append(OPERATOR, { ...EVENT, churchId: 'c1' }));
    expect(error.kind).toBe('tenancy');
    expect(error.message).toBe('runEvents: churchId would make this record tenant-scoped');
  });

  it('refuses a field the class does not declare, which is how a discriminator would sneak in unnamed', async () => {
    const { db } = fakeDb();
    const error = await rejected(repositoriesOn(db).runEvents.append(OPERATOR, { ...EVENT, scope: 'c1' }));
    expect(error.kind).toBe('schema');
    expect(error.message).toBe('runEvents: carries no field named scope');
  });

  it('refuses a record missing a value its class requires', async () => {
    const { db } = fakeDb();
    const missing = Object.fromEntries(Object.entries(EVENT).filter(([field]) => field !== 'sequence'));
    const error = await rejected(repositoriesOn(db).runEvents.append(OPERATOR, missing));
    expect(error.kind).toBe('schema');
    expect(error.message).toBe('runEvents: needs a value for sequence');
  });

  it('accepts a record that leaves an optional field out and one that carries its own identifier', async () => {
    const { db, calls } = fakeDb();
    const audit = requestContext({ ...OPERATOR, permissions: ['auditEvents.append'] });
    const entry = {
      at: '2026-09-13T09:00:00.000Z',
      action: 'settings.changed',
      subject: 'settings',
      outcome: 'allowed',
      actor: audit.actor,
      correlationId: audit.correlationId,
    };
    await repositoriesOn(db).auditEvents.append(audit, { _id: 'audit:1', ...entry });
    expect(calls[0]?.argument).toEqual({ _id: 'audit:1', ...entry });
  });

  it('refuses a record written under somebody else’s name or another request', async () => {
    const { db } = fakeDb();
    const wrongActor = await rejected(repositoriesOn(db).runEvents.append(OPERATOR, { ...EVENT, actor: 'account:0001' }));
    expect(wrongActor.kind).toBe('identity');
    expect(wrongActor.message).toBe('runEvents: actor account:0001 is not the context’s account:7f3a');
    const wrongRequest = await rejected(
      repositoriesOn(db).runEvents.append(OPERATOR, { ...EVENT, correlationId: 'req-other' }),
    );
    expect(wrongRequest.kind).toBe('identity');
    expect(wrongRequest.message).toBe('runEvents: correlationId req-other is not the context’s req-0f9c2a41');
  });

  it('reports a record that is already there as exactly that, not as an unknown failure', async () => {
    const { db } = fakeDb([], Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const error = await rejected(repositoriesOn(db).runEvents.append(OPERATOR, EVENT));
    expect(error.kind).toBe('duplicate');
    expect(error.message).toBe('runEvents: a record with that identifier is already there');
  });

  it('lets any other database failure through untranslated', async () => {
    const failure = new Error('connection reset');
    const { db } = fakeDb([], failure);
    await expect(repositoriesOn(db).runEvents.append(OPERATOR, EVENT)).rejects.toBe(failure);
  });
});

describe('reading durable records', () => {
  it('passes the filter and the paging the caller asked for', async () => {
    const { db, calls } = fakeDb([EVENT]);
    const rows = await repositoriesOn(db).runEvents.read(OPERATOR, { runId: 'run:1', sequence: { $gt: 0 } }, { limit: 10, sort: { sequence: 1 } });
    expect(rows).toEqual([EVENT]);
    expect(calls).toEqual([
      {
        collection: RECORDS.runEvents.collection,
        method: 'find',
        argument: { filter: { runId: 'run:1', sequence: { $gt: 0 } }, options: { limit: 10, sort: { sequence: 1 } } },
      },
    ]);
  });

  it('reads everything when the caller names no filter at all', async () => {
    const { db, calls } = fakeDb([EVENT]);
    await repositoriesOn(db).runEvents.read(OPERATOR);
    expect(calls[0]?.argument).toEqual({ filter: {}, options: {} });
  });

  it('counts with the same filter rules as a read', async () => {
    const { db, calls } = fakeDb([EVENT]);
    expect(await repositoriesOn(db).runEvents.count(OPERATOR, { runId: 'run:1' })).toBe(1);
    expect(calls[0]?.method).toBe('countDocuments');
    const error = await rejected(repositoriesOn(db).runEvents.count(OPERATOR, { tenantId: 't1' }));
    expect(error.kind).toBe('tenancy');
  });

  it('refuses a query that filters on a tenant discriminator, however deeply it is buried', async () => {
    const { db, calls } = fakeDb([EVENT]);
    const repositories = repositoriesOn(db);
    const top = await rejected(repositories.runEvents.read(OPERATOR, { tenantId: 't1' }));
    expect(top.kind).toBe('tenancy');
    expect(top.message).toBe('runEvents: a query may not filter on tenantId');
    const nested = await rejected(
      repositories.runEvents.read(OPERATOR, { $and: [{ runId: 'run:1' }, { $or: [{ churchId: 'c1' }] }] }),
    );
    expect(nested.kind).toBe('tenancy');
    expect(nested.message).toBe('runEvents: a query may not filter on churchId');
    expect(calls).toEqual([]);
  });

  it('refuses a query on a field the class does not declare', async () => {
    const { db } = fakeDb([EVENT]);
    const error = await rejected(repositoriesOn(db).runEvents.read(OPERATOR, { scope: 'c1' }));
    expect(error.kind).toBe('filter');
    expect(error.message).toBe('runEvents: carries no field named scope');
  });

  it('reads inside a field it does declare, because what a pinned revision holds is the domain’s business', async () => {
    const { db, calls } = fakeDb([EVENT]);
    await repositoriesOn(db).runEvents.read(OPERATOR, { 'pinnedRevisions.content': 'sha256:abc' });
    expect(calls[0]?.method).toBe('find');
  });

  it('refuses a sort or a limit that is not one, so a paging bug cannot read the whole history', async () => {
    const { db } = fakeDb([EVENT]);
    const repositories = repositoriesOn(db);
    expect((await rejected(repositories.runEvents.read(OPERATOR, {}, { limit: 0 }))).kind).toBe('filter');
    expect((await rejected(repositories.runEvents.read(OPERATOR, {}, { sort: { scope: 1 } }))).kind).toBe('filter');
  });

  it('refuses an actor the context does not permit to read', async () => {
    const { db } = fakeDb([EVENT]);
    const writer = requestContext({ ...OPERATOR, permissions: ['runEvents.append'] });
    const error = await rejected(repositoriesOn(db).runEvents.read(writer, {}));
    expect(error.kind).toBe('permission');
    expect(error.message).toBe('runEvents: the actor may not read, which needs runEvents.read');
  });
});

describe('the set of repositories', () => {
  it('holds one for every durable record class and nothing else', () => {
    const { db } = fakeDb();
    expect(Object.keys(repositoriesOn(db)).sort()).toEqual(Object.keys(RECORDS).sort());
  });

  it('cannot be handed a collection nothing declares', () => {
    const { db } = fakeDb();
    const set = repositoriesOn(db) as unknown as Record<string, unknown>;
    expect(set['unknown']).toBeUndefined();
  });

  it('offers no way to rewrite or delete a durable record', () => {
    const { db } = fakeDb();
    expect(Object.keys(repositoriesOn(db).runEvents).sort()).toEqual(['append', 'count', 'read', 'record']);
  });

  // Invariant 13: retention cleanup of one record class can never reach another's protected records —
  // proved here structurally, because no class offers a way to change or remove a record at all, of its
  // own or anyone else's. The database grants below auditEvents' own privileges hold up the other half.
  it('proves Invariant 13 structurally: no class, including auditEvents, exposes a way to change or remove a record', () => {
    const { db } = fakeDb();
    const built = repositoriesOn(db);
    for (const name of RECORD_NAMES) {
      const keys = Object.keys(built[name]);
      for (const forbidden of ['update', 'delete', 'remove', 'purge']) {
        expect(keys, `${name} exposes ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('reports a class nobody ships when the name arrived as data', () => {
    const { db } = fakeDb();
    const error = thrown(() => createIndexOn(db, 'unknown', { runId: 1 }));
    expect(error.kind).toBe('schema');
  });
});

describe('the indexes a schema needs', () => {
  it('are created and dropped by name, because an index is not a record', async () => {
    const { db, calls } = fakeDb();
    expect(await createIndexOn(db, 'runEvents', { runId: 1, sequence: 1 }, { unique: true, name: 'run_order' })).toBe('index-name');
    await dropIndexOn(db, 'runEvents', 'run_order');
    expect(calls).toEqual([
      { collection: RECORDS.runEvents.collection, method: 'createIndex', argument: { keys: { runId: 1, sequence: 1 }, options: { unique: true, name: 'run_order' } } },
      { collection: RECORDS.runEvents.collection, method: 'dropIndex', argument: 'run_order' },
    ]);
  });

  it('cannot be built on a field the class does not declare', () => {
    const { db } = fakeDb();
    const error = thrown(() => createIndexOn(db, 'runEvents', { scope: 1 }));
    expect(error.kind).toBe('filter');
    expect(error.message).toBe('runEvents: carries no field named scope');
  });
});

describe('filters that nest', () => {
  it('follows an $or into the filters it holds and refuses a discriminator there', async () => {
    const { db } = fakeDb();
    const error = await rejected(
      repositoriesOn(db).runEvents.read(OPERATOR, { $or: [{ runId: 'run:1' }, { churchId: 'first-church' }] }),
    );

    expect(error.kind).toBe('tenancy');
    expect(error.message).toContain('churchId');
  });

  it('refuses an operator this layer does not understand rather than passing it to the driver', async () => {
    const error = await rejected(repositoriesOn(fakeDb().db).runEvents.read(OPERATOR, { $where: 'this.runId' }));

    expect(error.kind).toBe('filter');
    expect(error.message).toContain('$where');
  });

  it('refuses an $and that does not hold a list of filters', async () => {
    const error = await rejected(repositoriesOn(fakeDb().db).runEvents.read(OPERATOR, { $and: { runId: 'run:1' } }));

    expect(error.kind).toBe('filter');
    expect(error.message).toContain('a list of filters');
  });

  it('refuses an $or holding something that is not a filter', async () => {
    const error = await rejected(repositoriesOn(fakeDb().db).runEvents.read(OPERATOR, { $or: ['runId'] }));

    expect(error.kind).toBe('filter');
    expect(error.message).toContain('a list of filters');
  });
});
