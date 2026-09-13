// The only way durable records are written or read.
//
// Every call carries an explicit request context (spec 6.4), every write is an append, and no query may
// name a tenant discriminator or a field its class does not declare. The absence of update and delete is
// the point rather than an omission: every class the foundation knows is append-only or immutable, so a
// migration or a feature that needs to reshape history writes new records beside the old ones — which is
// exactly what ADR 0009 asks of a schema change.

import { contextProblems } from './context.js';
import { RECORDS, RECORD_NAMES, discriminatorIn, permissionsFor, recordFor } from './records.js';

import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { RecordClass, RecordName } from './records.js';

export type Document = Readonly<Record<string, unknown>>;

export type Filter = Readonly<Record<string, unknown>>;

export interface ReadOptions {
  readonly limit?: number;
  readonly sort?: Readonly<Record<string, 1 | -1>>;
}

/** The slice of a Mongo database this layer uses. Narrow on purpose: a test can supply all of it. */
export interface RepositoryCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Document[]> };
  countDocuments(filter: Filter): Promise<number>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface RepositoryDb {
  collection(name: string): RepositoryCollection;
}

export type RefusalKind = 'context' | 'permission' | 'tenancy' | 'schema' | 'identity' | 'filter' | 'duplicate';

/** Carries why the call was refused, so a caller can tell a defect from a race. */
export class RepositoryError extends Error {
  readonly kind: RefusalKind;

  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.kind = kind;
  }
}

export interface Repository {
  readonly record: RecordClass;
  append(context: unknown, document: Document): Promise<string>;
  read(context: unknown, filter?: Filter, options?: ReadOptions): Promise<Document[]>;
  count(context: unknown, filter?: Filter): Promise<number>;
}

const DUPLICATE_KEY = 11_000;

function checkContext(name: RecordName, context: unknown, needed: 'append' | 'read'): RequestContext {
  const problems = contextProblems(context);
  if (problems.length > 0) throw new RepositoryError('context', `${name}: ${problems.join('; ')}`);
  const granted = (context as RequestContext).permissions;
  const permission = permissionsFor(name)[needed];
  if (!granted.includes(permission)) {
    throw new RepositoryError('permission', `${name}: the actor may not ${needed}, which needs ${permission}`);
  }
  return context as RequestContext;
}

// `_id` is Mongo's, not the class's: always allowed, never required, and never a place to hide a field.
const declares = (record: RecordClass, field: string): boolean => field === '_id' || field in record.fields;

function checkFieldNames(name: string, record: RecordClass, fields: readonly string[], kind: 'schema' | 'filter'): void {
  const discriminator = discriminatorIn(fields);
  if (discriminator !== undefined) {
    throw new RepositoryError(
      'tenancy',
      kind === 'schema'
        ? `${name}: ${discriminator} would make this record tenant-scoped`
        : `${name}: a query may not filter on ${discriminator}`,
    );
  }
  for (const field of fields) {
    if (!declares(record, field)) throw new RepositoryError(kind, `${name}: carries no field named ${field}`);
  }
}

// A filter nests: `$and`, `$nor` and `$or` hold more filters, each of which is checked in turn. Any other
// operator is refused rather than handed to the driver, so a filter this layer cannot read cannot run.
const FILTER_OPERATORS: readonly string[] = ['$and', '$nor', '$or'];

function filterFields(name: string, filter: Filter): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) {
      if (!FILTER_OPERATORS.includes(key)) {
        throw new RepositoryError('filter', `${name}: ${key} is not a filter operator this layer understands`);
      }
      if (!Array.isArray(value)) throw new RepositoryError('filter', `${name}: ${key} expects a list of filters`);
      for (const level of value) {
        if (typeof level !== 'object' || level === null) {
          throw new RepositoryError('filter', `${name}: ${key} expects a list of filters`);
        }
        fields.push(...filterFields(name, level as Filter));
      }
      continue;
    }
    fields.push(key.replace(/\..*$/u, ''));
  }
  return fields;
}

function checkFilter(name: string, record: RecordClass, filter: Filter, options: ReadOptions): void {
  checkFieldNames(name, record, filterFields(name, filter), 'filter');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new RepositoryError('filter', `${name}: a limit is a whole number of records, not ${String(options.limit)}`);
  }
  if (options.sort !== undefined) checkFieldNames(name, record, Object.keys(options.sort), 'filter');
}

function checkDocument(name: string, record: RecordClass, context: RequestContext, document: Document): void {
  checkFieldNames(name, record, Object.keys(document), 'schema');
  for (const [field, rule] of Object.entries(record.fields)) {
    if (rule === 'required' && document[field] === undefined) {
      throw new RepositoryError('schema', `${name}: needs a value for ${field}`);
    }
  }
  // History that can be written under another name is not history. The context is the only authority.
  for (const [field, expected] of [['actor', context.actor], ['correlationId', context.correlationId]] as const) {
    if (document[field] !== expected) {
      throw new RepositoryError('identity', `${name}: ${field} ${String(document[field])} is not the context’s ${expected}`);
    }
  }
}

function repositoryOn(db: RepositoryDb, name: RecordName): Repository {
  const record = RECORDS[name];
  const collection = (): RepositoryCollection => db.collection(record.collection);
  return {
    record,
    async append(context, document) {
      const checked = checkContext(name, context, 'append');
      checkDocument(name, record, checked, document);
      try {
        const { insertedId } = await collection().insertOne(document);
        return String(insertedId);
      } catch (error) {
        if ((error as { code?: unknown }).code === DUPLICATE_KEY) {
          throw new RepositoryError('duplicate', `${name}: a record with that identifier is already there`);
        }
        throw error;
      }
    },
    async read(context, filter = {}, options = {}) {
      checkContext(name, context, 'read');
      checkFilter(name, record, filter, options);
      return collection().find(filter, options).toArray();
    },
    async count(context, filter = {}) {
      checkContext(name, context, 'read');
      checkFilter(name, record, filter, {});
      return collection().countDocuments(filter);
    },
  };
}

/** One repository per durable record class, and no way to reach a collection nothing declares. */
export function repositoriesOn(db: RepositoryDb): Readonly<Record<RecordName, Repository>> {
  return Object.freeze(
    Object.fromEntries(RECORD_NAMES.map((name) => [name, repositoryOn(db, name)])) as Record<RecordName, Repository>,
  );
}

/**
 * Indexes are not records: creating or dropping one changes how a collection is read, never what it
 * holds, which is why a migration may do both while it may not rewrite a single durable record.
 */
export function createIndexOn(
  db: RepositoryDb,
  name: string,
  keys: Readonly<Record<string, 1 | -1>>,
  options: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const record = resolve(name);
  checkFieldNames(name, record, Object.keys(keys), 'filter');
  return db.collection(record.collection).createIndex(keys, options);
}

/**
 * The driver satisfies this interface in practice; the cast is only about `dropIndex` reporting the
 * document Mongo answers with, which no caller here reads.
 */
export function repositoryDb(db: Db): RepositoryDb {
  return { collection: (name) => db.collection(name) as unknown as RepositoryCollection };
}

export function dropIndexOn(db: RepositoryDb, name: string, index: string): Promise<void> {
  return db.collection(resolve(name).collection).dropIndex(index);
}

function resolve(name: string): RecordClass {
  try {
    return recordFor(name);
  } catch (error) {
    throw new RepositoryError('schema', (error as Error).message);
  }
}
