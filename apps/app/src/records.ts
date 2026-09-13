// The durable record classes the data layer knows, and the one thing none of them may carry.
//
// Spec 6.4 keeps v1 tenant-neutral: no durable record carries a tenant discriminator and no query
// filters on one, so a future multi-tenant model is an additive change rather than a schema rewrite.
// The field lists below are what makes that assertable — a discriminator cannot arrive as an
// undeclared field either, because the repository refuses a document whose keys it does not know.

export type RecordKind = 'append-only' | 'immutable';

export type FieldRule = 'required' | 'optional';

export interface RecordClass {
  /** The Mongo collection. One per class, never shared. */
  readonly collection: string;
  /** `append-only` grows; `immutable` grows and its records are never read back changed. Neither is rewritten. */
  readonly kind: RecordKind;
  /** Every field a record of this class may carry. `_id` is always allowed and never required. */
  readonly fields: Readonly<Record<string, FieldRule>>;
}

const HISTORY = { actor: 'required', correlationId: 'required' } as const;

export const RECORDS = {
  // Spec ADMN-03: a redacted, append-only audit trail. Retention may expire entries; nothing rewrites them.
  auditEvents: {
    collection: 'audit_events',
    kind: 'append-only',
    fields: { ...HISTORY, at: 'required', action: 'required', subject: 'required', outcome: 'required', detail: 'optional' },
  },
  // Spec DATA-02: content bodies append hash-addressed revisions, each recording how it came to exist.
  contentRevisions: {
    collection: 'content_revisions',
    kind: 'append-only',
    fields: { ...HISTORY, contentId: 'required', revision: 'required', hash: 'required', origin: 'required', at: 'required', body: 'required' },
  },
  // Spec PREP-01: the manifest pinning everything a run replays from, including the resolved geometry.
  preparedSnapshots: {
    collection: 'prepared_snapshots',
    kind: 'immutable',
    fields: { ...HISTORY, serviceId: 'required', preparedAt: 'required', pins: 'required', aspectRatio: 'required', safeArea: 'required' },
  },
  // Spec LIVE-12: every shown slide and operator change, in server order, with the revisions it pinned.
  runEvents: {
    collection: 'run_events',
    kind: 'immutable',
    fields: { ...HISTORY, runId: 'required', sequence: 'required', at: 'required', kind: 'required', pinnedRevisions: 'required' },
  },
  // ADR 0009's own ledger: the schema version is replayed from it rather than stored as a number to edit.
  schemaMigrations: {
    collection: 'schema_migrations',
    kind: 'append-only',
    fields: { ...HISTORY, version: 'required', direction: 'required', attempt: 'required', phase: 'required', at: 'required', detail: 'optional' },
  },
} as const satisfies Readonly<Record<string, RecordClass>>;

export type RecordName = keyof typeof RECORDS;

export const RECORD_NAMES: readonly RecordName[] = Object.freeze(
  (Object.keys(RECORDS) as RecordName[]).sort(),
);

/**
 * The field names a tenancy model would introduce. Written as whole names rather than as a substring
 * search, because `origin` contains `org` and a census that cries wolf gets switched off.
 */
export const DISCRIMINATOR_NAMES: readonly string[] = Object.freeze(
  [
    'churchId',
    'church_id',
    'congregationId',
    'congregation_id',
    'customerId',
    'customer_id',
    'orgId',
    'org_id',
    'organisationId',
    'organizationId',
    'siteId',
    'site_id',
    'tenant',
    'tenantId',
    'tenant_id',
    'workspaceId',
    'workspace_id',
  ].sort(),
);

const normalise = (name: string): string => name.toLowerCase().replaceAll('_', '');

const REFUSED = new Set(DISCRIMINATOR_NAMES.map(normalise));

/** The first name that would make a record tenant-scoped, or nothing if the set is neutral. */
export function discriminatorIn(names: Iterable<string>): string | undefined {
  for (const name of names) {
    const plain = normalise(name);
    // `tenant` anywhere is the one substring worth catching: no neutral field name contains it.
    if (plain.includes('tenant')) return name;
    if (REFUSED.has(plain)) return name;
    // A prefixed form — `primaryChurchId` — is the same field wearing a hat.
    if ([...REFUSED].some((refused) => refused.length > 5 && plain.endsWith(refused))) return name;
  }
  return undefined;
}

/** Raised rather than returned: a record class that does not exist is a defect, not a value. */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

const CLASSES: Readonly<Record<string, RecordClass | undefined>> = RECORDS;

/** Resolves a class by name, for the callers whose name arrived as data. */
export function recordFor(name: string): RecordClass {
  const record = CLASSES[name];
  if (record === undefined) throw new RecordError(`there is no durable record class named ${name}`);
  return record;
}

/**
 * The database privileges the data layer needs for a record class: read what is there, append to it, and
 * build the indexes a migration builds. Nothing that could change or remove a record is in the list, so a
 * deployment granting exactly this makes append-only the database’s rule rather than this layer’s promise.
 */
export const RECORD_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
]);

export interface RecordPrivileges {
  readonly collection: string;
  readonly actions: readonly string[];
}

export function privilegesFor(name: RecordName): RecordPrivileges {
  return { collection: RECORDS[name].collection, actions: RECORD_ACTIONS };
}

export interface RecordPermissions {
  readonly read: string;
  readonly append: string;
}

/** Named after the class, so registering a record class never means inventing a permission vocabulary. */
export function permissionsFor(name: RecordName): RecordPermissions {
  return { read: `${name}.read`, append: `${name}.append` };
}
