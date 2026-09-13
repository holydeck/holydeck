// What every durable thing in HolyDeck carries, and what archiving or deleting one means. DATA-01 asks
// for two separate promises: a stamp no stored entity is missing — an identifier, when it changed and
// who changed it, and the schema version it was written by — and archive and deletion behaviour that is
// stated per kind rather than assumed. Both are here, as data, so a kind whose behaviour nobody decided
// cannot be stored at all; the kinds arrive as their requirements do, and the list is closed on purpose.

import { FIELD_CODES, type FieldReader, type Parsed, parseObject } from './problems.js';

/** Every field the stamp carries, in the order a stored entity reads. */
export const ENTITY_STAMP_FIELDS = [
  'id',
  'kind',
  'schemaVersion',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'archivedAt',
  'archivedBy',
] as const;

export type EntityStampField = (typeof ENTITY_STAMP_FIELDS)[number];

/** What archiving does to an entity people can still see references to. */
export const ARCHIVE_EFFECTS = [
  // It stops being offered where things are chosen, and every existing reference keeps resolving.
  'hidden',
  // It stays where it is listed and stops taking effect, because its history is the reason to keep it.
  'disabled',
] as const;

export type ArchiveEffect = (typeof ARCHIVE_EFFECTS)[number];

export const DELETION_RULES = ['never', 'purge-after-grace'] as const;

export type DeletionRule = (typeof DELETION_RULES)[number];

export const ENTITY_KINDS = ['contentLanguage', 'mediaAsset', 'service', 'slideLayout', 'song'] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityPolicy = {
  readonly kind: EntityKind;
  /** The version this build writes. A stored entity may be older; it may never be newer. */
  readonly schemaVersion: number;
  readonly archive: ArchiveEffect;
  readonly deletion: DeletionRule;
  /** Days between archival and the first moment a purge may be asked for. Present exactly when one may. */
  readonly graceDays: number | undefined;
  /** Whether this kind is a portable configuration, which `./portable.js` exports and imports. */
  readonly portable: boolean;
  /** Where the behaviour above was decided, so changing it means changing a requirement first. */
  readonly requirement: string;
};

// One entry per kind, and a kind is added here when a requirement says what archiving it does — not when
// code first needs to store one. An empty archive column would be the assumption DATA-01 exists to refuse.
export const ENTITY_POLICIES: Readonly<Record<EntityKind, EntityPolicy>> = Object.freeze({
  contentLanguage: {
    kind: 'contentLanguage',
    schemaVersion: 1,
    archive: 'hidden',
    deletion: 'never',
    graceDays: undefined,
    portable: false,
    // The registry carries an active/archive state, and a layout box bound to a language has to keep
    // resolving it, because a missing binding blocks readiness rather than degrading quietly.
    requirement: 'SEED-01 with §11',
  },
  mediaAsset: {
    kind: 'mediaAsset',
    schemaVersion: 1,
    archive: 'hidden',
    deletion: 'purge-after-grace',
    graceDays: 180,
    portable: false,
    requirement: 'MEDI-01',
  },
  service: {
    kind: 'service',
    schemaVersion: 1,
    // A service reaches Archived through its own states, and its delivery is immutable from Completed
    // onward, so archiving one ends joining and presenting and leaves the history where it is.
    archive: 'disabled',
    deletion: 'never',
    graceDays: undefined,
    portable: false,
    requirement: 'SERV-03 with DELT-01',
  },
  slideLayout: {
    kind: 'slideLayout',
    schemaVersion: 1,
    archive: 'hidden',
    deletion: 'never',
    graceDays: undefined,
    portable: false,
    requirement: 'TMPL-01 with TMPL-02',
  },
  song: {
    kind: 'song',
    schemaVersion: 1,
    archive: 'hidden',
    deletion: 'never',
    graceDays: undefined,
    portable: true,
    requirement: 'SONG-01 with DELT-01',
  },
});

/** The kinds a portable configuration can be, in the order `ENTITY_KINDS` names them. */
export const PORTABLE_KINDS: readonly EntityKind[] = Object.freeze(
  ENTITY_KINDS.filter((kind) => ENTITY_POLICIES[kind].portable),
);

/** A kind nothing decided anything about is a defect in this build, not a rejected payload. */
export class EntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityError';
  }
}

export function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

/** Resolves a kind that arrived as data, refusing one this build has decided nothing about. */
export function policyFor(kind: string): EntityPolicy {
  if (!isEntityKind(kind)) throw new EntityError(`there is no durable entity kind named ${kind}`);
  return ENTITY_POLICIES[kind];
}

type StampFields = {
  readonly id: string;
  readonly kind: EntityKind;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
};

/** An archived entity has both the instant it was archived at and the person who archived it. */
export type ArchivedEntity = StampFields & {
  readonly archivedAt: string;
  readonly archivedBy: string;
};

export type LiveEntity = StampFields & {
  readonly archivedAt: undefined;
  readonly archivedBy: undefined;
};

// The two shapes are separate types rather than one with optional fields, so asking when a purge becomes
// possible is only expressible about an entity that has actually been archived.
export type EntityStamp = ArchivedEntity | LiveEntity;

const at = (instant: string): number => Date.parse(instant);

const readVersion = (reader: FieldReader, kind: EntityKind): number => {
  const version = reader.wholeNumber('schemaVersion', 1);
  const current = ENTITY_POLICIES[kind].schemaVersion;
  if (version > current) {
    reader.reject('schemaVersion', FIELD_CODES.notAllowed, `must be at most the current version ${current}`);
  }
  return version;
};

const readArchival = (reader: FieldReader, createdAt: string): ArchivedEntity | LiveEntity | undefined => {
  const archivedAt = reader.optionalTime('archivedAt');
  const archivedBy = reader.optionalText('archivedBy');
  if (archivedBy === '') reader.reject('archivedBy', FIELD_CODES.empty, 'must not be empty');
  if (archivedAt !== undefined && at(archivedAt) < at(createdAt)) {
    reader.reject('archivedAt', FIELD_CODES.notAllowed, 'must not be before the entity was created');
  }
  if (archivedAt !== undefined && archivedBy !== undefined) return { archivedAt, archivedBy } as ArchivedEntity;
  if (archivedAt === undefined && archivedBy === undefined) {
    return { archivedAt: undefined, archivedBy: undefined } as LiveEntity;
  }
  const missing = archivedAt === undefined ? 'archivedAt' : 'archivedBy';
  reader.reject(missing, FIELD_CODES.required, 'is required');
  return undefined;
};

/** Reads one stored entity's stamp, or every reason it is not one. */
export function parseEntityStamp(value: unknown): Parsed<EntityStamp> {
  return parseObject(value, 'entity', (reader) => {
    const id = reader.text('id');
    const kind = reader.choice('kind', ENTITY_KINDS);
    const schemaVersion = readVersion(reader, kind);
    const createdAt = reader.time('createdAt');
    const createdBy = reader.text('createdBy');
    const updatedAt = reader.time('updatedAt');
    if (at(updatedAt) < at(createdAt)) {
      reader.reject('updatedAt', FIELD_CODES.notAllowed, 'must not be before the entity was created');
    }
    const fields: StampFields = {
      id,
      kind,
      schemaVersion,
      createdAt,
      createdBy,
      updatedAt,
      updatedBy: reader.text('updatedBy'),
    };
    const archival = readArchival(reader, createdAt);
    return { ...fields, ...(archival ?? { archivedAt: undefined, archivedBy: undefined }) } as EntityStamp;
  });
}

type Change = {
  readonly at: string;
  readonly by: string;
};

const isLive = (stamp: EntityStamp): stamp is LiveEntity => stamp.archivedAt === undefined;

/** Stamps a new entity, at the schema version this build writes, with one person and one instant. */
export function createdStamp(options: { readonly id: string; readonly kind: EntityKind } & Change): LiveEntity {
  return {
    id: options.id,
    kind: options.kind,
    schemaVersion: ENTITY_POLICIES[options.kind].schemaVersion,
    createdAt: options.at,
    createdBy: options.by,
    updatedAt: options.at,
    updatedBy: options.by,
    archivedAt: undefined,
    archivedBy: undefined,
  };
}

/** Records a change to a live entity. Archiving is what stops one changing, so an archived one refuses. */
export function touchedStamp(stamp: EntityStamp, change: Change): LiveEntity {
  if (!isLive(stamp)) throw new EntityError(`${stamp.id} is archived`);
  return { ...stamp, updatedAt: change.at, updatedBy: change.by };
}

export function archivedStamp(stamp: EntityStamp, change: Change): ArchivedEntity {
  if (!isLive(stamp)) throw new EntityError(`${stamp.id} is already archived`);
  return { ...stamp, updatedAt: change.at, updatedBy: change.by, archivedAt: change.at, archivedBy: change.by };
}

export function restoredStamp(stamp: EntityStamp, change: Change): LiveEntity {
  if (isLive(stamp)) throw new EntityError(`${stamp.id} is not archived`);
  return { ...stamp, updatedAt: change.at, updatedBy: change.by, archivedAt: undefined, archivedBy: undefined };
}

/**
 * Why this entity may not be purged, or nothing when it may. Deletion is revalidated immediately before
 * it happens rather than when a cleanup screen was drawn, so this reads the entity it is about and the
 * policy of that entity's own kind instead of taking either on trust.
 */
export function purgeRefusal(stamp: EntityStamp, now: string): string | undefined {
  if (isLive(stamp)) return `${stamp.id} is not archived`;
  const eligible = purgeableAt(ENTITY_POLICIES[stamp.kind], stamp.archivedAt);
  if (eligible === undefined) return `a ${stamp.kind} is never purged`;
  if (at(now) < at(eligible)) return `${stamp.id} may not be purged before ${eligible}`;
  return undefined;
}

const DAY_MS = 86_400_000;

/** The first instant an archived entity may be purged at, or nothing when its kind is never deleted. */
export function purgeableAt(policy: EntityPolicy, archivedAt: string): string | undefined {
  if (policy.graceDays === undefined) return undefined;
  return new Date(at(archivedAt) + policy.graceDays * DAY_MS).toISOString();
}
