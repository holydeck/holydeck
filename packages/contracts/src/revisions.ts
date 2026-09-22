// One content revision, as the store appends it and reads it back. A revision is addressed by the hash of
// its canonical body (ADR 0001), so the address is what makes two saves the same save; the ordinal beside
// it is what makes history a sequence rather than a set. Both are written down here because the rules that
// can be judged from the records alone belong with the record, while appending, detecting a save that
// changed nothing and restoring an earlier body are the store's behaviour and belong with it.
//
// Nothing here hashes anything: a digest is the runtime's to compute, and the browser and the server do
// not compute it the same way. What travels is the address format and the bytes it is taken over.

import { canonicalJson } from './canonical.js';
import { FIELD_CODES, isRecord, type Parsed, type Problem, parseObject } from './problems.js';

/** How a revision came to exist (specification §8.3). A restore is a checkpoint: it is what a person did. */
export const REVISION_ORIGINS = ['autosave', 'manual-checkpoint'] as const;

export type RevisionOrigin = (typeof REVISION_ORIGINS)[number];

/** Every field a revision carries, in the order a record reads. */
export const REVISION_FIELDS = [
  'contentId',
  'revision',
  'hash',
  'origin',
  'at',
  'actor',
  'correlationId',
  'body',
] as const;

export type RevisionField = (typeof REVISION_FIELDS)[number];

export const HASH_ALGORITHM = 'sha256';

/** What separates a content identifier from its ordinal in a revision's key, and so cannot be in either. */
export const REVISION_KEY_SEPARATOR = '#';

const ADDRESS = new RegExp(`^${HASH_ALGORITHM}-[0-9a-f]{64}$`, 'u');

export type RevisionBody = Readonly<Record<string, unknown>>;

export interface RevisionRecord {
  readonly contentId: string;
  /** The ordinal, counting from one. History grows by one and never by anything else. */
  readonly revision: number;
  readonly hash: string;
  readonly origin: RevisionOrigin;
  readonly at: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly body: RevisionBody;
}

/** The address carries the algorithm that produced it, so changing the algorithm cannot be ambiguous. */
export const revisionAddress = (digest: string): string => `${HASH_ALGORITHM}-${digest}`;

export const isRevisionAddress = (value: string): boolean => ADDRESS.test(value);

/** The bytes a revision's address is taken over: the canonical form of the body, and nothing else. */
export const revisionBytes = (body: RevisionBody): string => canonicalJson(body);

/** The identity of a revision as the database stores it, so a second revision 3 is a duplicate key. */
export const revisionKey = (contentId: string, revision: number): string =>
  `${contentId}${REVISION_KEY_SEPARATOR}${revision}`;

export function parseRevisionRecord(value: unknown): Parsed<RevisionRecord> {
  return parseObject(value, 'revision', (reader) => {
    const contentId = reader.text('contentId');
    if (contentId.includes(REVISION_KEY_SEPARATOR)) {
      reader.reject(
        'contentId',
        FIELD_CODES.notAllowed,
        `must not contain ${REVISION_KEY_SEPARATOR}, which separates it from the ordinal in a revision's key`,
      );
    }
    const hash = reader.text('hash');
    if (hash !== '' && !isRevisionAddress(hash)) {
      reader.reject('hash', FIELD_CODES.notAllowed, `must be a ${HASH_ALGORITHM} address of the canonical body`);
    }
    const raw = reader.present('body');
    if (raw !== undefined && !isRecord(raw)) reader.reject('body', FIELD_CODES.notAnObject, 'must be an object');
    return {
      contentId,
      revision: reader.wholeNumber('revision', 1),
      hash,
      origin: reader.choice('origin', REVISION_ORIGINS),
      at: reader.time('at'),
      actor: reader.text('actor'),
      correlationId: reader.text('correlationId'),
      body: isRecord(raw) ? raw : {},
    };
  });
}

/**
 * What a whole history has to be, read as a whole: one content's revisions, starting at one and growing by
 * one. A gap is a revision that was removed and a repeat is a revision that was written twice, and neither
 * can happen to an append-only store that nothing rewrites — so finding either says the store was gone
 * around rather than that this history is unusual.
 */
export function historyProblems(revisions: readonly RevisionRecord[]): string[] {
  const problems: string[] = [];
  const [first] = revisions;
  if (first === undefined) return problems;
  if (first.revision !== 1) problems.push(`revision ${first.revision}: history starts at revision 1`);
  let previous = first;
  for (const revision of revisions.slice(1)) {
    if (revision.contentId !== first.contentId) {
      problems.push(`revision ${revision.revision}: belongs to ${revision.contentId}, not to ${first.contentId}`);
    }
    if (revision.revision !== previous.revision + 1) {
      problems.push(
        `revision ${revision.revision}: follows revision ${previous.revision}, and history only ever grows by one`,
      );
    }
    previous = revision;
  }
  return problems;
}

/** The two places in history a comparison reads, always ordinals a stored revision can actually have. */
export interface RevisionCompareQuery {
  readonly from: number;
  readonly to: number;
}

/** Reads an ordinal from the query text without admitting a partial number as a history position. */
function wholeNumberQueryField(
  query: Readonly<Record<string, string | undefined>>,
  name: string,
  path: string,
  problems: Problem[],
): number | undefined {
  const raw = query[name];
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    problems.push({ path: `${path}.${name}`, code: FIELD_CODES.required, message: 'is required' });
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    problems.push({
      path: `${path}.${name}`,
      code: FIELD_CODES.notAWholeNumber,
      message: 'must be a whole number of at least 1',
    });
    return undefined;
  }
  return Number(trimmed);
}

/** Reads a comparison as two existing-style ordinals, so a route never has to interpret query text itself. */
export function parseRevisionCompareQuery(
  query: Readonly<Record<string, string | undefined>>,
  path = 'query',
): Parsed<RevisionCompareQuery> {
  const problems: Problem[] = [];
  const from = wholeNumberQueryField(query, 'from', path, problems);
  const to = wholeNumberQueryField(query, 'to', path, problems);
  if (problems.length > 0 || from === undefined || to === undefined) return { ok: false, problems };
  return { ok: true, value: { from, to } };
}
