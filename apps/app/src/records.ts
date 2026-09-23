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
  // Spec BACK-01: one row per backup run, naming the manifest it produced and the consistency it read
  // under. A backup is never revised once made — a later run is a new backup, not a correction of an
  // older one — so this is immutable like `runEvents`, not a stamp history like `services`.
  backups: {
    collection: 'backups',
    kind: 'immutable',
    fields: { ...HISTORY, backupId: 'required', at: 'required', manifest: 'required', consistency: 'required' },
  },
  // Spec COLL-01: the losing side of an edit race, kept rather than dropped. Two kinds of row share the
  // collection and neither is ever rewritten: a `shelved` row is the body a writer lost the ordinal for,
  // and a `resolved` row is a later note naming the shelved row somebody settled and the revision that
  // settled it. That is why the five fields below are optional — each kind carries its own pair, and a
  // row carrying neither pair is a row `collaboration.ts`'s parser refuses. `contentId` is deliberately
  // the word `contentRevisions` already uses, because a shelf row is about exactly that key space.
  conflictShelf: {
    collection: 'conflict_shelf',
    kind: 'append-only',
    fields: {
      ...HISTORY,
      contentId: 'required',
      sequence: 'required',
      kind: 'required',
      at: 'required',
      attempted: 'optional',
      origin: 'optional',
      body: 'optional',
      resolves: 'optional',
      revision: 'optional',
    },
  },
  // Spec SEED-01 with §11: the persisted content-language registry — one row per change to one key,
  // the same append-only stamp history `slideLabels` keeps, and for the same reason. A language has
  // no separately versioned body at all: its display name, script and fallback font are the whole of
  // it, so all three are written inline on the stamped row, exactly as a label's name is.
  contentLanguages: {
    collection: 'content_languages',
    kind: 'append-only',
    fields: {
      ...HISTORY,
      languageKey: 'required',
      sequence: 'required',
      at: 'required',
      displayName: 'required',
      script: 'required',
      fallbackFont: 'required',
      stamp: 'required',
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
  // Spec LIVE-14: content a run took on while it was already on. A class of its own rather than a field
  // on `contentRevisions`, because a revision records how a save was triggered and never when in a
  // service's life it happened; that a row is here at all is what says the content was added mid-service.
  // `contentId` is the same word `contentRevisions` uses, and names the same key space: the body is saved
  // there under exactly this identifier. `libraryId` is the separate identifier `contentLibrary` minted
  // for the one addition somebody explicitly decided to keep, and is absent for every addition nobody did.
  midServiceAdditions: {
    collection: 'mid_service_additions',
    kind: 'immutable',
    fields: { ...HISTORY, contentId: 'required', runId: 'required', at: 'required', libraryId: 'optional' },
  },
  // Spec AUTH-04, Decision D08-1: a PPTX import session holds one uploaded file's parsed result between
  // upload, review and commit — actor-owned, and time-boxed to 24 hours from the moment it was created.
  // No layer under this one has an update or delete verb, so a session that must be "updated" once
  // reviewed, and "removed" on discard, is kept the same way `slideLayouts` keeps its own stamp: one row
  // per change, `sequence` counting from one, and the standing session being the highest `sequence` a
  // `sessionId` has. `createdAt` is written once at `sequence` 1 and carried forward unchanged by every
  // later row, unlike `reviewedAt`/`discardedAt`, which each name the one event that appended them.
  pptxImportSessions: {
    collection: 'pptx_import_sessions',
    kind: 'append-only',
    fields: {
      ...HISTORY,
      sessionId: 'required',
      sequence: 'required',
      createdAt: 'required',
      fileName: 'required',
      expiresAt: 'required',
      slides: 'required',
      skippedMedia: 'required',
      provenance: 'required',
      duplicate: 'optional',
      reviewed: 'optional',
      reviewedAt: 'optional',
      discardedAt: 'optional',
    },
  },
  // Spec PREP-01: the manifest pinning everything a run replays from, including the resolved geometry.
  preparedSnapshots: {
    collection: 'prepared_snapshots',
    kind: 'immutable',
    fields: {
      ...HISTORY,
      serviceId: 'required',
      preparedAt: 'required',
      pins: 'required',
      aspectRatio: 'required',
      safeArea: 'required',
      // ADR 0004: the source and Slide Layout revisions a generated slide group was projected from.
      // Optional so a manifest written before this field existed reads back unchanged.
      generatedSlides: 'optional',
    },
  },
  // Spec LIVE-01: a presentation run's own lifecycle — one row per start or end, keyed by `runId` like
  // `runEvents`, but a table of its own: this is the run starting and ending, not the slides and operator
  // changes `runEvents` logs while it is on (see `runs.ts`'s header for why the two never share a row).
  presentationRuns: {
    collection: 'presentation_runs',
    kind: 'append-only',
    fields: {
      ...HISTORY,
      runId: 'required',
      sequence: 'required',
      at: 'required',
      serviceId: 'required',
      snapshotId: 'required',
      phase: 'required',
      mode: 'required',
      position: 'required',
    },
  },
  // Spec BACK-02: one row per restore rehearsal, holding the whole manifest a restore is what completes —
  // the `manifest` and `consistency` the backup run produced, plus the `integrity`, `objectives` and
  // `restore` sections only actually recovering from it can fill in. A class of its own rather than an
  // amendment to the `backups` row, because that row is immutable: a rehearsal is a new fact about an old
  // backup, and rewriting the backup to carry it would be the one thing these classes never do.
  restores: {
    collection: 'restores',
    kind: 'immutable',
    fields: {
      ...HISTORY,
      restoreId: 'required',
      backupId: 'required',
      at: 'required',
      manifest: 'required',
      consistency: 'required',
      integrity: 'required',
      objectives: 'required',
      restore: 'required',
    },
  },
  // Spec LIVE-12: every shown slide and operator change, in server order, with the revisions it pinned.
  // `shown` is optional because most of what this log holds moved nothing into view — a theme change, a
  // Standby, an override. An event that did carries what it put in front of the room, which is what spec
  // LIVE-13's review of the exact references shown is derived from (`run-review.ts`). Rows written before
  // this field existed are never backfilled — an identity nobody recorded cannot be recovered, and this log
  // is immutable besides — so a review of an older run leaves those out rather than guessing at them.
  runEvents: {
    collection: 'run_events',
    kind: 'immutable',
    fields: {
      ...HISTORY,
      runId: 'required',
      sequence: 'required',
      at: 'required',
      kind: 'required',
      pinnedRevisions: 'required',
      shown: 'optional',
    },
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
  songSingerChords: {
    collection: 'song_singer_chords',
    kind: 'append-only',
    fields: { ...HISTORY, songId: 'required', singerId: 'required', sequence: 'required', at: 'required', chords: 'required', stamp: 'required' },
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
