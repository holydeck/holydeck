// How a configuration leaves one HolyDeck and arrives in another. DATA-01 asks a portable file to declare
// a system-managed kind and schema version, and asks import to validate the kind, migrate only the older
// versions somebody has actually declared a step for, and refuse a newer one without a partial write.
//
// Nothing here touches a database, which is what makes the last promise keepable: import is a function
// from text to a document or to every reason it is not one, so there is no half-applied import to undo.
// The schema version a document carries is the version of the file shape, not of the stored entity —
// storage can change without changing what an export looks like — so each portable kind declares its own
// and the steps that lead to it. Songs are edited as YAML (SONG-01); this is the byte-stable interchange
// form that surface reads and writes through, and the export is canonical so an unchanged song re-exports
// to identical bytes.

import { type EntityKind, EntityError, PORTABLE_KINDS } from './entities.js';
import { FIELD_CODES, isRecord, type Parsed, parseObject } from './problems.js';

export const PORTABLE_FORMAT = 'holydeck.portable';

/** The version of the envelope itself, which changes only when the declaration around a body changes. */
export const PORTABLE_FORMAT_VERSION = 1;

export type PortableBody = Readonly<Record<string, unknown>>;

/** One declared version step. A version with no step out of it is a version this build cannot read. */
export type MigrationStep = {
  readonly from: number;
  readonly to: number;
  readonly migrate: (body: PortableBody) => PortableBody;
};

export type PortableSchema = {
  readonly kind: EntityKind;
  /** The version this build writes. */
  readonly schemaVersion: number;
  /** The oldest version a declared step leads out of, and so the oldest file that can be read. */
  readonly oldest: number;
  readonly steps: readonly MigrationStep[];
};

export type PortableDocument = {
  readonly format: typeof PORTABLE_FORMAT;
  readonly formatVersion: number;
  readonly kind: EntityKind;
  readonly schemaVersion: number;
  readonly body: PortableBody;
};

const chained = (steps: readonly MigrationStep[]): boolean => {
  let previous: MigrationStep | undefined;
  for (const step of steps) {
    if (step.to !== step.from + 1) return false;
    if (previous !== undefined && step.from !== previous.to) return false;
    previous = step;
  }
  return true;
};

/**
 * Declares what one kind's export looks like and how older ones reach it. Everything it refuses is a
 * defect in this build rather than a bad file, so it throws where the readers below collect problems.
 */
export function portableSchema(
  kind: EntityKind,
  schemaVersion: number,
  steps: readonly MigrationStep[],
): PortableSchema {
  if (!PORTABLE_KINDS.includes(kind)) throw new EntityError(`${kind} is not a portable kind`);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new EntityError(`${kind} cannot be at schema version ${schemaVersion}`);
  }
  if (!chained(steps)) throw new EntityError(`the steps of ${kind} do not run one version at a time`);
  const last = steps.at(-1);
  if (last !== undefined && last.to !== schemaVersion) {
    throw new EntityError(`the last step of ${kind} reaches version ${last.to}, not ${schemaVersion}`);
  }
  return { kind, schemaVersion, oldest: steps.at(0)?.from ?? schemaVersion, steps };
}

/** Stamps a body with the declaration a reader identifies it by. */
export function portableDocument(schema: PortableSchema, body: PortableBody): PortableDocument {
  return {
    format: PORTABLE_FORMAT,
    formatVersion: PORTABLE_FORMAT_VERSION,
    kind: schema.kind,
    schemaVersion: schema.schemaVersion,
    body,
  };
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) sorted[key] = canonical(value[key]);
  return sorted;
};

/**
 * Writes a document as the bytes it travels as: the declaration first, every object sorted, and a
 * trailing newline. Two exports of the same configuration are the same bytes, so a file kept under
 * version control shows a diff only when the configuration actually changed.
 */
export function exportText(document: PortableDocument): string {
  const ordered = {
    format: document.format,
    formatVersion: document.formatVersion,
    kind: document.kind,
    schemaVersion: document.schemaVersion,
    body: canonical(document.body),
  };
  return `${JSON.stringify(ordered, undefined, 2)}\n`;
}

const migrate = (schema: PortableSchema, from: number, body: PortableBody): PortableBody => {
  let migrated: PortableBody = { ...body };
  for (const step of schema.steps) {
    if (step.from >= from) migrated = step.migrate(migrated);
  }
  return migrated;
};

/** Reads a document that arrived already parsed, such as an upload a server decoded as JSON. */
export function readPortable(value: unknown, schema: PortableSchema): Parsed<PortableDocument> {
  return parseObject(value, 'document', (reader) => {
    const format = reader.choice('format', [PORTABLE_FORMAT]);
    const formatVersion = reader.wholeNumber('formatVersion', 1);
    if (formatVersion > PORTABLE_FORMAT_VERSION) {
      reader.reject(
        'formatVersion',
        FIELD_CODES.notAllowed,
        `must be at most ${PORTABLE_FORMAT_VERSION}, the format this build reads`,
      );
    }
    // One rule rather than two: the kind is graded against the schema it is being imported into, and a
    // schema only exists for a kind that travels, so a file of another kind cannot reach that schema's
    // body rules by being a kind this build otherwise knows.
    const kind = reader.text('kind');
    if (kind !== '' && kind !== schema.kind) {
      reader.reject('kind', FIELD_CODES.notAllowed, `must be ${schema.kind}, which is what is being imported`);
    }
    const schemaVersion = reader.wholeNumber('schemaVersion', 1);
    if (schemaVersion > schema.schemaVersion) {
      reader.reject(
        'schemaVersion',
        FIELD_CODES.notAllowed,
        `must be at most ${schema.schemaVersion}, the version this build writes`,
      );
    } else if (schemaVersion < schema.oldest) {
      reader.reject(
        'schemaVersion',
        FIELD_CODES.notAllowed,
        `must be at least ${schema.oldest}, the oldest version a migration is declared from`,
      );
    }
    const raw = reader.present('body');
    if (raw !== undefined && !isRecord(raw)) reader.reject('body', FIELD_CODES.notAnObject, 'must be an object');
    const body = isRecord(raw) ? raw : {};
    // Migrating only a document that is otherwise whole keeps a declared step from being handed the
    // stand-in body a rejected field leaves behind.
    const readable = reader.problems.length === 0;
    return {
      format,
      formatVersion,
      kind: schema.kind,
      schemaVersion: schema.schemaVersion,
      body: readable ? migrate(schema, schemaVersion, body) : body,
    };
  });
}

/** Reads the bytes an export wrote, or every reason they are not a document this build can import. */
export function importText(text: string, schema: PortableSchema): Parsed<PortableDocument> {
  return readPortable(parsedJson(text), schema);
}

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
