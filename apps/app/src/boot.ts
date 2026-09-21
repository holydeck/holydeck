import { readFileSync } from 'node:fs';

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

/** Refused because the settings path names a mount point rather than living inside one. */
export class SettingsMountError extends Error {
  constructor(path: string) {
    super(
      `${path} is itself a mount point; mount its parent directory instead. Settings are replaced ` +
        'atomically — a new file written and renamed over the old one — which changes the inode, and ' +
        'a bind mount of the file keeps following the inode it was given at container start.',
    );
    this.name = 'SettingsMountError';
  }
}

const MOUNTINFO_PATH = '/proc/self/mountinfo';

/**
 * Reads this process's own mount table, or undefined where there is none to read — a development
 * machine, most obviously, since this file is Linux-only and that is what the built image runs on.
 */
export function readMountInfo(read: (path: string) => string, path: string = MOUNTINFO_PATH): string | undefined {
  try {
    return read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A table that exists but cannot be read is the same deployment fault readSettingsText refuses to
    // guess through: starting anyway would mean starting without knowing whether the mount is sound.
    throw error;
  }
}

// The fifth space-separated field of an /proc/self/mountinfo line is the mount point, whatever optional
// fields precede the "-" separator later in the line; the fields before it never move. Real mountinfo
// lines are single-space-separated, so split(' ') is exact here even though it would not be for
// arbitrary whitespace.
const MOUNT_POINT_FIELD = 4;

// mountinfo escapes space, tab, newline and backslash as their octal code, the same way /proc/mounts
// does, so a path that happens to contain one of those characters is still one line.
const OCTAL_ESCAPE = /\\([0-7]{3})/gu;

const unescapeMountPath = (raw: string): string =>
  raw.replace(OCTAL_ESCAPE, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/** Every path this process sees mounted directly, read out of an /proc/self/mountinfo listing. */
export function mountedPaths(mountinfoText: string): Set<string> {
  const paths = new Set<string>();
  for (const line of mountinfoText.split('\n')) {
    if (line.trim() === '') continue;
    const field = line.split(' ')[MOUNT_POINT_FIELD];
    if (field !== undefined) paths.add(unescapeMountPath(field));
  }
  return paths;
}

/**
 * Refuses a settings path that is itself the target of a mount, rather than its parent directory being
 * one — the mistake settings.ts's own header already warns against, caught here for the one place that
 * warning cannot reach: a deployment's own Compose override, which nothing in this repository reads.
 * A deployment with no mount table to consult is not refused, because there is nothing here to catch it
 * on; the static check over the Compose files this repository ships is what covers that case instead.
 */
export function checkSettingsMount(path: string, mounts: ReadonlySet<string>): void {
  if (mounts.has(path)) throw new SettingsMountError(path);
}

/**
 * The whole preflight, run the same way by every process that opens the settings file: the application,
 * the migration, the worker and the worker's own healthcheck. Each used to repeat the composition of
 * readMountInfo and mountedPaths verbatim; this is that composition, written once.
 */
export function checkOwnSettingsMount(
  path: string,
  read: (path: string) => string = (file) => readFileSync(file, 'utf8'),
): void {
  checkSettingsMount(path, mountedPaths(readMountInfo(read) ?? ''));
}
