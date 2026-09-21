// The deployment-level preflight, DEPL-03's own: configuration validation, migration preflight and
// backup preflight, each capable of blocking a deployment before it starts. Not to be confused with
// `apps/cli`'s `runPreflight`, which checks a sermon's Bible passages are available — a different
// preflight, over a different question, in a different package. Every check here composes an
// already-shipped module (`settings.ts`'s `loadSettings`, `migrations.ts`'s `SchemaStatus`, `restores.ts`'s
// `RECOVERY_OBJECTIVES`) rather than repeating what that module already decides; this only grades the
// answer it gives, so there is exactly one place each of those decisions is made.

import { MIGRATIONS } from './migrations.js';
import { RECOVERY_OBJECTIVES } from './restores.js';
import { SettingsError, loadSettings } from './settings.js';

import type { RecordedBackup } from './backups.js';
import type { SchemaMigration, SchemaStatus } from './migrations.js';

export interface PreflightResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const PASS: PreflightResult = Object.freeze({ ok: true, problems: Object.freeze([]) });

const fail = (problems: readonly string[]): PreflightResult => ({ ok: false, problems });

/** Blocks on any settings file or environment this build could not actually start on. */
export function configurationPreflight(input: {
  readonly fileText?: string;
  readonly env?: Record<string, string | undefined>;
  readonly path?: string;
}): PreflightResult {
  try {
    loadSettings(input);
    return PASS;
  } catch (error) {
    if (error instanceof SettingsError) return fail(error.problems);
    throw error;
  }
}

/**
 * Blocks a deployment the schema itself is not ready for: a half-finished migration, a database ahead of
 * what this build knows, or a pending migration this build cannot actually undo. `checkSchema` (boot.ts)
 * makes the same call at the moment the application actually starts; this exists so a deployment can be
 * refused before that moment — before a container is even brought up.
 */
export function migrationPreflight(
  status: SchemaStatus,
  migrations: readonly SchemaMigration[] = MIGRATIONS,
): PreflightResult {
  const problems: string[] = [];
  if (status.blocked !== undefined) {
    const { version, direction, attempt } = status.blocked;
    problems.push(
      `schema version ${version} is half migrated (${direction}, attempt ${attempt}); roll it back with ` +
        '`node dist/migrate.js --rollback` before deploying',
    );
  }
  if (status.recorded > status.required) {
    problems.push(
      `the database is at schema version ${status.recorded}, ahead of what this build (${status.required}) knows`,
    );
  }
  for (const version of status.pending) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (migration === undefined) {
      problems.push(`schema version ${version} is pending but this build ships no such migration`);
    } else if (typeof migration.down !== 'function') {
      problems.push(
        `schema version ${version} (${migration.name}) has no rollback: it could not be undone if it failed partway`,
      );
    } else {
      problems.push(`schema version ${version} (${migration.name}) is pending; run \`node dist/migrate.js\` before deploying`);
    }
  }
  return problems.length === 0 ? PASS : fail(problems);
}

/**
 * Blocks a deployment with nothing recent enough to restore from if it goes wrong. The staleness bound is
 * `restores.ts`'s own recovery point objective, not a number invented here — one bound, read from the one
 * place it is decided.
 */
export function backupPreflight(backups: readonly RecordedBackup[], now: Date = new Date()): PreflightResult {
  const [latest] = backups;
  if (latest === undefined) {
    return fail(['no backup has ever been recorded; there is nothing to restore from if this deployment goes wrong']);
  }
  const ageMinutes = (now.getTime() - Date.parse(latest.at)) / 60_000;
  if (ageMinutes > RECOVERY_OBJECTIVES.rpoMinutes) {
    return fail([
      `the last recorded backup (${latest.at}) is ${Math.round(ageMinutes)} minutes old, past the ` +
        `${RECOVERY_OBJECTIVES.rpoMinutes}-minute recovery point objective`,
    ]);
  }
  return PASS;
}

export interface DeployPreflightInput {
  readonly configuration: {
    readonly fileText?: string;
    readonly env?: Record<string, string | undefined>;
    readonly path?: string;
  };
  readonly schema: SchemaStatus;
  readonly migrations?: readonly SchemaMigration[];
  readonly backups: readonly RecordedBackup[];
  readonly now?: Date;
}

export interface DeployPreflightReport {
  readonly ok: boolean;
  readonly configuration: PreflightResult;
  readonly migration: PreflightResult;
  readonly backup: PreflightResult;
}

/**
 * The whole deployment preflight, composed of the three checks above. Every check runs and reports,
 * rather than stopping at the first refusal, so one preflight attempt surfaces everything wrong with a
 * deployment at once instead of one problem per attempt.
 */
export function deployPreflight(input: DeployPreflightInput): DeployPreflightReport {
  const configuration = configurationPreflight(input.configuration);
  const migration = migrationPreflight(input.schema, input.migrations);
  const backup = backupPreflight(input.backups, input.now);
  return { ok: configuration.ok && migration.ok && backup.ok, configuration, migration, backup };
}
