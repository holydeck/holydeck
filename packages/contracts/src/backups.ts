// The backup manifest, in the two halves it is written in. A backup run produces the first —
// `parseBackupProduction`: what the archive holds and the consistency it was read under. Only a restore
// can produce the second — `parseBackupManifest`: that the archive was verified before a byte of it was
// applied, what recovering from it actually cost against the objectives it was held to, and that the
// recovery ended every session that was open before it. A manifest carrying only the first half is a
// backup nobody has yet proved is worth anything, which is why the two parsers are separate and the full
// one is never what a producer writes.

import { FIELD_CODES, type FieldReader, type ParseFn, type Parsed, parseObject } from './problems.js';

export interface BackupContent {
  readonly class: string;
  readonly count: number;
  readonly bytes: number;
  readonly hash: string;
}

export interface BackupManifestBody {
  readonly id: string;
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly contents: readonly BackupContent[];
  readonly excludedSecrets: readonly string[];
}

export interface BackupConsistency {
  readonly pointInTime: true;
  readonly method: string;
}

export interface BackupProduction {
  readonly manifest: BackupManifestBody;
  readonly consistency: BackupConsistency;
}

const parseContent: ParseFn<BackupContent> = (value, path) =>
  parseObject(value, path, (reader) => ({
    class: reader.text('class'),
    count: reader.wholeNumber('count'),
    bytes: reader.wholeNumber('bytes'),
    hash: reader.text('hash'),
  }));

const readContents = (reader: FieldReader): readonly BackupContent[] => {
  const contents = reader.parsedList('contents', parseContent);
  if (contents.length === 0) reader.reject('contents', FIELD_CODES.notAllowed, 'lists no contents');
  return contents;
};

const readExcludedSecrets = (reader: FieldReader, contents: readonly BackupContent[]): readonly string[] => {
  const excluded = reader.textList('excludedSecrets');
  if (excluded.length === 0) {
    reader.reject('excludedSecrets', FIELD_CODES.notAllowed, 'excludes no secrets, so the exclusion is not deliberate');
  }
  for (const secret of excluded) {
    if (contents.some((content) => content.class === secret)) {
      reader.reject('excludedSecrets', FIELD_CODES.notAllowed, `${secret} is both excluded and included`);
    }
  }
  return excluded;
};

const EMPTY_MANIFEST: BackupManifestBody = { id: '', createdAt: '', schemaVersion: 0, contents: [], excludedSecrets: [] };

const EMPTY_CONSISTENCY: BackupConsistency = { pointInTime: true, method: '' };

const parseManifestBody: ParseFn<BackupManifestBody> = (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const createdAt = reader.time('createdAt');
    const schemaVersion = reader.wholeNumber('schemaVersion', 1);
    const contents = readContents(reader);
    const excludedSecrets = readExcludedSecrets(reader, contents);
    return { id, createdAt, schemaVersion, contents, excludedSecrets };
  });

const parseConsistency: ParseFn<BackupConsistency> = (value, path) =>
  parseObject(value, path, (reader) => {
    if (!reader.flag('pointInTime')) reader.reject('pointInTime', FIELD_CODES.notAllowed, 'is not point-in-time consistent');
    const method = reader.text('method');
    return { pointInTime: true, method };
  });

/** Grades what a backup run itself produced: a non-empty, hash-addressed inventory read under a snapshot. */
export function parseBackupProduction(value: unknown): Parsed<BackupProduction> {
  return parseObject(value, 'backup', (reader) => ({
    manifest: reader.parsed('manifest', parseManifestBody, EMPTY_MANIFEST),
    consistency: reader.parsed('consistency', parseConsistency, EMPTY_CONSISTENCY),
  }));
}

export interface BackupIntegrity {
  readonly verifiedBeforeRestore: true;
  /** What the check actually was. A restore that names no algorithm is a restore nobody can repeat. */
  readonly algorithm: string;
  readonly mismatchAborts: true;
}

/** What recovering from this backup cost, in the same units the objectives are stated in. */
export interface RecoveryMeasurement {
  readonly rpoMinutes: number;
  readonly rtoMinutes: number;
}

export interface BackupObjectives {
  readonly rpoMinutes: number;
  readonly rtoMinutes: number;
  /** Timed, never assumed: a target with nothing measured against it is a target nobody has met. */
  readonly measured: RecoveryMeasurement;
}

export interface BackupRollback {
  readonly plan: string;
  readonly verified: true;
  /** The day the plan was last carried out, when it was recorded. A date, not an instant. */
  readonly verifiedOn?: string;
}

export interface BackupRestore {
  readonly sessionsInvalidated: true;
  readonly rollback: BackupRollback;
}

/** The whole manifest: what was backed up, and what restoring it proved. */
export interface BackupManifest extends BackupProduction {
  readonly integrity: BackupIntegrity;
  readonly objectives: BackupObjectives;
  readonly restore: BackupRestore;
}

const parseIntegrity: ParseFn<BackupIntegrity> = (value, path) =>
  parseObject(value, path, (reader) => {
    if (!reader.flag('verifiedBeforeRestore')) {
      reader.reject('verifiedBeforeRestore', FIELD_CODES.notAllowed, 'did not verify integrity first');
    }
    const algorithm = reader.text('algorithm');
    if (!reader.flag('mismatchAborts')) {
      reader.reject('mismatchAborts', FIELD_CODES.notAllowed, 'continues past an integrity mismatch');
    }
    return { verifiedBeforeRestore: true, algorithm, mismatchAborts: true };
  });

const RECOVERY_KEYS = ['rpoMinutes', 'rtoMinutes'] as const;

/**
 * A figure a rehearsal timed. Absent reads as "was never measured" rather than "is required", because
 * the two say different things: one is a malformed payload, the other is an objective nobody has tested.
 */
const readMeasured = (reader: FieldReader, name: (typeof RECOVERY_KEYS)[number]): number => {
  if (!reader.names.includes(name)) {
    reader.reject(name, FIELD_CODES.required, 'was never measured');
    return 0;
  }
  return reader.wholeNumber(name);
};

const parseMeasurement: ParseFn<RecoveryMeasurement> = (value, path) =>
  parseObject(value, path, (reader) => ({
    rpoMinutes: readMeasured(reader, 'rpoMinutes'),
    rtoMinutes: readMeasured(reader, 'rtoMinutes'),
  }));

const EMPTY_MEASUREMENT: RecoveryMeasurement = { rpoMinutes: 0, rtoMinutes: 0 };

const parseObjectives: ParseFn<BackupObjectives> = (value, path) =>
  parseObject(value, path, (reader) => {
    const targets = { rpoMinutes: reader.wholeNumber('rpoMinutes', 1), rtoMinutes: reader.wholeNumber('rtoMinutes', 1) };
    const measured = reader.parsed('measured', parseMeasurement, EMPTY_MEASUREMENT);
    for (const key of RECOVERY_KEYS) {
      if (measured[key] > targets[key]) {
        reader.reject(`measured.${key}`, FIELD_CODES.tooLarge, `measured ${key} misses its target`);
      }
    }
    return { ...targets, measured };
  });

const parseRollback: ParseFn<BackupRollback> = (value, path) =>
  parseObject(value, path, (reader) => {
    const plan = reader.text('plan');
    if (!reader.flag('verified')) reader.reject('verified', FIELD_CODES.notAllowed, 'the rollback was never verified');
    // A day, not a UTC instant: what is being recorded is when somebody last carried the plan out.
    const verifiedOn = reader.optionalText('verifiedOn');
    return { plan, verified: true, verifiedOn };
  });

const EMPTY_ROLLBACK: BackupRollback = { plan: '', verified: true };

const parseRestore: ParseFn<BackupRestore> = (value, path) =>
  parseObject(value, path, (reader) => {
    if (!reader.flag('sessionsInvalidated')) {
      reader.reject('sessionsInvalidated', FIELD_CODES.notAllowed, 'left sessions valid across a restore');
    }
    return { sessionsInvalidated: true, rollback: reader.parsed('rollback', parseRollback, EMPTY_ROLLBACK) };
  });

const EMPTY_INTEGRITY: BackupIntegrity = { verifiedBeforeRestore: true, algorithm: '', mismatchAborts: true };

const EMPTY_OBJECTIVES: BackupObjectives = { rpoMinutes: 0, rtoMinutes: 0, measured: EMPTY_MEASUREMENT };

const EMPTY_RESTORE: BackupRestore = { sessionsInvalidated: true, rollback: EMPTY_ROLLBACK };

/**
 * Grades the whole manifest, which only a restore can fill in: everything a backup run had to get right,
 * plus the four things nothing but actually restoring it can answer — that the archive was checked before
 * it was applied, that a mismatch stops the restore rather than being noted in passing, that the recovery
 * came in inside the objectives it is held to, and that the sessions open before it no longer are.
 */
export function parseBackupManifest(value: unknown): Parsed<BackupManifest> {
  return parseObject(value, 'backup', (reader) => ({
    manifest: reader.parsed('manifest', parseManifestBody, EMPTY_MANIFEST),
    consistency: reader.parsed('consistency', parseConsistency, EMPTY_CONSISTENCY),
    integrity: reader.parsed('integrity', parseIntegrity, EMPTY_INTEGRITY),
    objectives: reader.parsed('objectives', parseObjectives, EMPTY_OBJECTIVES),
    restore: reader.parsed('restore', parseRestore, EMPTY_RESTORE),
  }));
}
