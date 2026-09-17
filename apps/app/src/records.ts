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
    fields: {
      ...HISTORY,
      at: 'required',
      action: 'required',
      subject: 'required',
      outcome: 'required',
      detail: 'optional',
      requestTokens: 'optional',
      responseTokens: 'optional',
      durationMs: 'optional',
    },
  },
  // Spec CONT-01: the discoverability index for reusable content — one row per stamp change, the same
  // append-only shape `slideLayouts` uses. `contentId` is deliberately the same word `contentRevisions`
  // already uses for its own key, not a domain-suffixed name like `layoutId`/`serviceId`: this table's
  // entire purpose is minting the identifier a later revision (T47/T51/T64) is saved under, and calling
  // it anything else would hide that the two tables share a key space.
  contentLibrary: {
    collection: 'content_library',
    kind: 'append-only',
    fields: { ...HISTORY, contentId: 'required', sequence: 'required', at: 'required', title: 'required', stamp: 'required' },
  },
  // Spec DATA-02: content bodies append hash-addressed revisions, each recording how it came to exist.
  contentRevisions: {
    collection: 'content_revisions',
    kind: 'append-only',
    fields: { ...HISTORY, contentId: 'required', revision: 'required', hash: 'required', origin: 'required', at: 'required', body: 'required' },
  },
  mediaAssets: {
    collection: 'media_assets',
    kind: 'append-only',
    fields: { ...HISTORY, assetId: 'required', sequence: 'required', at: 'required', manifest: 'required', storageKey: 'required', stamp: 'required' },
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
  // Spec TMPL-04: a Service Template's own stamp — its name, and when and by whom it was defined. No
  // update verb exists for one yet, because no requirement says what changing or archiving one does (see
  // service-templates.ts's own header); each Service Template is therefore exactly one row, keyed by its
  // own identifier rather than a growing stamp history like `slideLayouts`.
  serviceTemplates: {
    collection: 'service_templates',
    kind: 'append-only',
    fields: { ...HISTORY, name: 'required', createdAt: 'required', createdBy: 'required' },
  },
  // Spec SERV-01: a Service's own stamp, kept as a history of stamps like `slideLayouts` rather than
  // one row edited in place — a Service has no separately-versioned body to delegate to, so its
  // sections and items are written inline on the same stamped row.
  services: {
    collection: 'services',
    kind: 'append-only',
    fields: {
      ...HISTORY,
      serviceId: 'required',
      sequence: 'required',
      at: 'required',
      title: 'required',
      date: 'required',
      site: 'required',
      state: 'required',
      sections: 'required',
      stamp: 'required',
    },
  },
  // Spec LABL-01: one row per change to one entry of the global slide-label catalogue — the same
  // append-only stamp history `slideLayouts` keeps, and for the same reason. A label has no separately
  // versioned body at all: what it is called and which live key jumps to it are the whole of it, so both
  // are written inline on the stamped row. `shortcut` is the one optional field, because a label that is
  // assignable without being reachable by a single keypress is a label with no key rather than a label
  // with an empty one.
  slideLabels: {
    collection: 'slide_labels',
    kind: 'append-only',
    fields: { ...HISTORY, labelId: 'required', sequence: 'required', at: 'required', name: 'required', shortcut: 'optional', stamp: 'required' },
  },
  // Spec TMPL-01: a Slide Layout's own stamp and name, apart from the boxes it holds. Append-only like
  // everything else, so its lifecycle is a history of stamps rather than one row edited in place: the
  // standing stamp is the highest `sequence` a `layoutId` has, and a second writer claiming that same
  // ordinal is a duplicate key rather than a lost change.
  slideLayouts: {
    collection: 'slide_layouts',
    kind: 'append-only',
    fields: { ...HISTORY, layoutId: 'required', sequence: 'required', at: 'required', name: 'required', stamp: 'required' },
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
