// The half of the backup manifest a backup run itself produces: what the archive holds, and the
// consistency it was read under. Whether a restored copy matched it and what restoring it did next are a
// later reader's business, not a producer's, so this module carries only `manifest` and `consistency`.

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
