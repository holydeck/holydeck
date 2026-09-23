// Spec AUTH-04, Decision D08-1: the session a PPTX import lives in between upload, review and commit.
//
// `pptx-import.ts` turns bytes into a `PptxImportResult` and `pptx-review.ts` grades a caller's
// decisions against it, but neither one holds anything between round trips — a caller that uploaded a
// deck and now wants to review it a moment later, from a different request, has nowhere to read the
// parsed result back from. This module is that holding place, and nothing else: it does not parse a
// `.pptx` (that is `pptx-import.ts`'s job) and it does not grade a review (that is `pptx-review.ts`'s),
// it only remembers one caller's own result long enough for those two steps to be joined across requests.
//
// Kept the same way `slide-layouts.ts` keeps its own stamp, because no layer under this one has an
// update or delete verb: `review` and `discard` each append a new row with `sequence` incremented rather
// than rewriting or removing the one before it, and the standing session is the highest `sequence` a
// `sessionId` has. A session is owned by the actor who created it and expires 24 hours after — `get`
// answers `undefined` for a session that is missing, discarded, expired, or somebody else's, and
// deliberately does not distinguish between those four: a caller who does not own a session, or whose
// session already lapsed, learns nothing more from this store than a caller who invented an identifier.

import { randomBytes } from 'node:crypto';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { repositoriesOn } from './repositories.js';

import type { RequestContext } from './context.js';
import type {
  PptxDuplicateCandidate,
  PptxImportResult,
  PptxImportSlide,
  PptxProvenance,
  PptxSkippedMedia,
} from './pptx-import.js';
import type { PptxReviewedBlock } from './pptx-review.js';
import type { RepositoryDb } from './repositories.js';

/** The record class the session history lives in. Named once, because the permissions read off it. */
export const PPTX_SESSION_RECORD = 'pptxImportSessions';

export const PPTX_SESSION_PERMISSIONS = permissionsFor(PPTX_SESSION_RECORD);

/** The one context a PPTX import session is administered under: this store, and nothing else. */
export function pptxSessionContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(PPTX_SESSION_PERMISSIONS)],
    correlationId,
  });
}

/** A PPTX import session as a caller reads it back: the parsed result it was created with, plus
 *  whatever review has since been appended onto it. */
export interface PptxSessionRecord {
  readonly id: string;
  readonly actor: string;
  readonly fileName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly slides: readonly PptxImportSlide[];
  readonly skippedMedia: readonly PptxSkippedMedia[];
  readonly provenance: PptxProvenance;
  readonly duplicate: PptxDuplicateCandidate | undefined;
  readonly reviewed: readonly PptxReviewedBlock[] | undefined;
  readonly reviewedAt: string | undefined;
}

export interface PptxSessionStore {
  create(context: unknown, input: { readonly fileName: string; readonly result: PptxImportResult }): Promise<PptxSessionRecord>;
  /** Own-session only: a session belonging to a different actor, or expired, answers undefined — the
   *  caller cannot tell "not yours" from "doesn't exist". */
  get(context: unknown, id: string): Promise<PptxSessionRecord | undefined>;
  review(context: unknown, id: string, reviewed: readonly PptxReviewedBlock[]): Promise<PptxSessionRecord | undefined>;
  discard(context: unknown, id: string): Promise<boolean>;
}

export interface PptxSessionOptions {
  /** Injected, so every instant this store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const SESSION_ID_BYTES = 16;

const SESSION_SEPARATOR = '#';

/** A session is good for exactly one day from the moment it was created (spec AUTH-04). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** What one session row holds, once it has been read back as something this build understands. Every
 *  field the record class carries except `correlationId`, which is write-only — added only by `author`
 *  at append time, the same as `slide-layouts.ts`'s own `StampRow` never surfaces it either. */
interface Row {
  readonly sessionId: string;
  readonly sequence: number;
  readonly actor: string;
  readonly createdAt: string;
  readonly fileName: string;
  readonly expiresAt: string;
  readonly slides: readonly PptxImportSlide[];
  readonly skippedMedia: readonly PptxSkippedMedia[];
  readonly provenance: PptxProvenance;
  readonly duplicate: PptxDuplicateCandidate | undefined;
  readonly reviewed: readonly PptxReviewedBlock[] | undefined;
  readonly reviewedAt: string | undefined;
  readonly discardedAt: string | undefined;
}

export function pptxSessionsOn(db: RepositoryDb, options: PptxSessionOptions): PptxSessionStore {
  const records = repositoriesOn(db)[PPTX_SESSION_RECORD];
  const newId = options.newId ?? ((): string => randomBytes(SESSION_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    // Nothing is checked here: every call below has already read through the repository by this point, and
    // that layer refuses a context it cannot read as surely as it refuses an actor who may not append.
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  // Picked field by field rather than cast wholesale, so a raw row's own `_id`/`correlationId` never
  // rides along into a `Row` this file builds forward from — spreading one of those into the next row's
  // append would silently clobber the freshly computed `_id` the next `sequence` is supposed to get.
  const rowFrom = (found: Record<string, unknown>): Row => ({
    sessionId: found['sessionId'] as string,
    sequence: found['sequence'] as number,
    actor: found['actor'] as string,
    createdAt: found['createdAt'] as string,
    fileName: found['fileName'] as string,
    expiresAt: found['expiresAt'] as string,
    slides: found['slides'] as readonly PptxImportSlide[],
    skippedMedia: found['skippedMedia'] as readonly PptxSkippedMedia[],
    provenance: found['provenance'] as PptxProvenance,
    duplicate: found['duplicate'] as PptxDuplicateCandidate | undefined,
    reviewed: found['reviewed'] as readonly PptxReviewedBlock[] | undefined,
    reviewedAt: found['reviewedAt'] as string | undefined,
    discardedAt: found['discardedAt'] as string | undefined,
  });

  /** The standing row of one session, or nothing at all when no such session was ever created. */
  const latestRow = async (context: unknown, id: string): Promise<Row | undefined> => {
    const [found] = await records.read(context, { sessionId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  /** The standing row, but only when it is still this caller's to read: not missing, not discarded, not
   *  expired, and not somebody else's session — checked in that order, and every one of the four answers
   *  the same `undefined` rather than a refusal, since none of them is this caller's business to tell apart. */
  const readable = async (context: unknown, id: string): Promise<Row | undefined> => {
    const row = await latestRow(context, id);
    if (row === undefined) return undefined;
    if (row.discardedAt !== undefined) return undefined;
    if (Date.parse(row.expiresAt) < Date.parse(options.now())) return undefined;
    if (row.actor !== (context as RequestContext).actor) return undefined;
    return row;
  };

  const toRecord = (row: Row): PptxSessionRecord => ({
    id: row.sessionId,
    actor: row.actor,
    fileName: row.fileName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    slides: row.slides,
    skippedMedia: row.skippedMedia,
    provenance: row.provenance,
    duplicate: row.duplicate,
    reviewed: row.reviewed,
    reviewedAt: row.reviewedAt,
  });

  const append = (context: unknown, row: Row): Promise<string> =>
    records.append(context, {
      _id: `${row.sessionId}${SESSION_SEPARATOR}${row.sequence}`,
      ...row,
      ...author(context),
    });

  return {
    create: async (context, input) => {
      const createdAt = options.now();
      const row: Row = {
        sessionId: newId(),
        sequence: 1,
        actor: (context as RequestContext).actor,
        createdAt,
        fileName: input.fileName,
        expiresAt: new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString(),
        slides: input.result.slides,
        skippedMedia: input.result.skippedMedia,
        provenance: input.result.provenance,
        duplicate: input.result.duplicate,
        reviewed: undefined,
        reviewedAt: undefined,
        discardedAt: undefined,
      };
      await append(context, row);
      return toRecord(row);
    },

    get: async (context, id) => {
      const row = await readable(context, id);
      return row === undefined ? undefined : toRecord(row);
    },

    review: async (context, id, reviewed) => {
      const row = await readable(context, id);
      if (row === undefined) return undefined;
      const next: Row = { ...row, sequence: row.sequence + 1, reviewed, reviewedAt: options.now() };
      await append(context, next);
      return toRecord(next);
    },

    discard: async (context, id) => {
      const row = await readable(context, id);
      if (row === undefined) return false;
      const next: Row = { ...row, sequence: row.sequence + 1, discardedAt: options.now() };
      await append(context, next);
      return true;
    },
  };
}
