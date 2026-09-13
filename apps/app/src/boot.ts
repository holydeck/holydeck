import { corpusBoundaryProblems } from '@holydeck/contracts/corpus';
import { MESSAGE_CODES, REMOVED_CODES, messageCodeProblems } from '@holydeck/contracts/http';

import { corpusBoundaryFor, corpusProbeProblems } from './corpus.js';

import type { CorpusProbe, CorpusSettings } from './corpus.js';
import type { SchemaStatus } from './migrations.js';

/** Reads the settings file if it is there. A fresh install has none, and that is not a fault. */
export function readSettingsText(read: (path: string) => string, path: string): string | undefined {
  try {
    return read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A file that exists but cannot be read is a deployment fault: refusing to start beats
    // starting on defaults the administrator did not choose.
    throw error;
  }
}

/**
 * Grades the released message code registry before the service starts serving from it. A registry that
 * has repurposed or withdrawn a code is a promise already broken, and it is better to refuse to start
 * than to hand clients a code that no longer means what they were told it means.
 */
export function checkReleasedContracts(
  codes: unknown = MESSAGE_CODES,
  removedCodes: unknown = REMOVED_CODES,
): void {
  const problems = messageCodeProblems(codes, removedCodes);
  if (problems.length > 0) {
    throw new Error(`the released message codes cannot be served: ${problems.join('; ')}`);
  }
}

const refuseToStart = (reason: string, problems: readonly string[]): void => {
  if (problems.length > 0) throw new Error(`${reason}: ${problems.join('; ')}`);
};

/**
 * Grades the boundary this deployment presents against the documented one. The settings already refuse
 * an address the outside world can reach; this grades the whole packet — the client, the credential and
 * the routes the application depends on — so a build whose contract has drifted is caught here rather
 * than in front of a congregation.
 */
export function checkCorpusBoundary(corpus: CorpusSettings): void {
  if (corpus.url === '') return;
  refuseToStart('the corpus boundary is not one this application will cross', corpusBoundaryProblems(corpusBoundaryFor(corpus)));
}

/**
 * Grades the database against the version this build was written for. Serving a database a migration has
 * not been run against, or one a newer build has already migrated, means reading records under a shape
 * they were not written in; a half-finished run means the schema is neither version. All three refuse to
 * start, and the migration itself is a separate command rather than something a start-up does quietly.
 */
export function checkSchema(status: SchemaStatus): void {
  const blocked = status.blocked;
  if (blocked !== undefined) {
    throw new Error(
      `the database is half migrated: version ${blocked.version} (${blocked.direction}, attempt ${blocked.attempt}) ` +
        'never finished. Roll it back with `node dist/migrate.js --rollback` before starting.',
    );
  }
  if (status.pending.length > 0) {
    throw new Error(
      `the database is at schema version ${status.recorded} and this build needs ${status.required}. ` +
        'Run `node dist/migrate.js` before starting.',
    );
  }
  if (status.recorded > status.required) {
    throw new Error(
      `the database is at schema version ${status.recorded} and this build was written for ${status.required}: ` +
        'deploy the newer build, or roll the database back to the version this one knows.',
    );
  }
}

/** A corpus that answers anyone who can reach it is a deployment fault, not something to serve through. */
export function checkCorpusIsClosed(probe: CorpusProbe): void {
  refuseToStart('the corpus is open', corpusProbeProblems(probe));
}
