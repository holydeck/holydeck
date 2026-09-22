// One-time migration for a deployment that was started before Mongo authentication was required
// (see compose.yaml's mongo service). Starts a throwaway mongo:8 container bound to the
// deployment's *existing* data volume with authentication not enforced, creates the root user and
// the application user only if each is missing, and stops the throwaway container again. Never
// overwrites a password that is already set, and never prints one.
//
//   HOLYDECK_MONGO_ROOT_PASSWORD=... HOLYDECK_MONGO_PASSWORD=... node scripts/ops/mongo-enable-auth.mjs
//
// Run this with the real stack stopped (docker compose down, keeping its volumes) — it refuses to
// run otherwise, so it never contends with a mongod already serving the same data. See
// MAINTENANCE.md's "Migrating an existing deployment to Mongo authentication" for the full
// operator procedure, including the backup and rollback steps around this script.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_VOLUME = 'holydeck_mongo-data';
export const DEFAULT_CONTAINER = 'holydeck-mongo-enable-auth';
const IMAGE = 'mongo:8';
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_SECONDS = '0.5';

// Replaces every occurrence of a known secret with a placeholder, so a Docker error that echoes an
// argv or an eval script back never carries a password into this script's own output.
const scrub = (text, secrets) =>
  secrets.reduce((result, secret) => (secret ? result.split(secret).join('***') : result), text);

const docker = (args, secrets = []) => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8' });
  } catch (error) {
    // Deliberately not `{ cause: error }`: the caught error's own message/stdout/stderr can carry
    // a password (it is the unscrubbed argv/output this whole wrapper exists to scrub), and a
    // `cause` chain prints in full — including to an uncaught-exception handler — regardless of
    // what this function's own thrown message says.
    const scrubbed = new Error(scrub(String(error.message ?? error), secrets));
    scrubbed.stdout = scrub(String(error.stdout ?? ''), secrets);
    scrubbed.stderr = scrub(String(error.stderr ?? ''), secrets);
    throw scrubbed;
  }
};

// Every container currently mounting this volume — a non-empty answer means some mongod (the real
// stack's, or a leftover of this same script) is already serving the data this script would touch.
const containersUsing = (volume) =>
  docker(['ps', '--filter', `volume=${volume}`, '--format', '{{.Names}}'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const mongoEval = (container, db, script, envVars, secrets) =>
  docker(
    [
      'exec',
      ...Object.entries(envVars).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      container,
      'mongosh',
      db,
      '--quiet',
      '--eval',
      script,
    ],
    secrets,
  ).trim();

const waitUntilReady = (container) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      docker(['exec', container, 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"]);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`mongo never became ready in ${container}: ${error.message}`, { cause: error });
      }
      execFileSync('sleep', [READY_POLL_SECONDS]);
    }
  }
};

const hasUser = (container, db, user) =>
  mongoEval(container, db, `db.getUsers({ filter: { user: '${user}' } }).users.length > 0`, {}, []) === 'true';

/**
 * Ensures the root and application users exist against `container`'s data, creating whichever one
 * is missing and leaving the other untouched. Returns what it did, for the caller to report — never
 * the passwords themselves.
 */
export function ensureUsers(container, { rootPassword, appPassword }) {
  const secrets = [rootPassword, appPassword];
  const report = {};

  if (hasUser(container, 'admin', 'root')) {
    report.root = 'already exists (left untouched)';
  } else {
    mongoEval(
      container,
      'admin',
      "db.createUser({ user: 'root', pwd: process.env.HOLYDECK_MONGO_ROOT_PASSWORD, roles: [{ role: 'root', db: 'admin' }] })",
      { HOLYDECK_MONGO_ROOT_PASSWORD: rootPassword },
      secrets,
    );
    report.root = 'created';
  }

  if (hasUser(container, 'holydeck', 'holydeck')) {
    report.app = 'already exists (left untouched)';
  } else {
    // Same readWrite + dbAdmin shape as deploy/mongo-init/01-app-user.js: readWrite for normal
    // operation, dbAdmin because migrate.js changes schema/indexes.
    mongoEval(
      container,
      'holydeck',
      "db.createUser({ user: 'holydeck', pwd: process.env.HOLYDECK_MONGO_PASSWORD, roles: [" +
        "{ role: 'readWrite', db: 'holydeck' }, { role: 'dbAdmin', db: 'holydeck' }] })",
      { HOLYDECK_MONGO_PASSWORD: appPassword },
      secrets,
    );
    report.app = 'created';
  }

  return report;
}

/**
 * Runs the full migration against `volume`: refuses if anything is already using it, otherwise
 * starts a throwaway, unauthenticated mongod bound to it, creates whichever of the root/app users
 * is missing, and always stops the throwaway container again before returning.
 */
export function run({ env, volume = DEFAULT_VOLUME, container = DEFAULT_CONTAINER }) {
  const rootPassword = env.HOLYDECK_MONGO_ROOT_PASSWORD;
  const appPassword = env.HOLYDECK_MONGO_PASSWORD;
  if (!rootPassword || !appPassword) {
    throw new Error('HOLYDECK_MONGO_ROOT_PASSWORD and HOLYDECK_MONGO_PASSWORD are both required');
  }

  const running = containersUsing(volume);
  if (running.length > 0) {
    throw new Error(`${volume} is already in use by ${running.join(', ')} — stop the stack first`);
  }

  // A stopped container left over from a prior run that crashed before its own cleanup would
  // otherwise collide with `--name` below; it is not "in use" (the guard above already checked
  // that), just stale.
  try {
    docker(['rm', '--force', container]);
  } catch {
    // nothing to clean up
  }

  docker(['run', '--detach', '--name', container, '--volume', `${volume}:/data/db`, IMAGE]);
  try {
    waitUntilReady(container);
    return ensureUsers(container, { rootPassword, appPassword });
  } finally {
    // A graceful stop first, not a bare `rm --force` (SIGKILL): this volume goes back to the real
    // stack right after this script exits, and mongod needs the chance to flush and shut down
    // cleanly rather than leaving recovery for the next process that opens it.
    try {
      docker(['stop', container]);
    } catch {
      // already stopped or gone — rm below still runs
    }
    docker(['rm', '--force', container]);
  }
}

function main() {
  let report;
  try {
    report = run({ env: process.env });
  } catch (error) {
    console.error(`mongo-enable-auth: ${error.message}`);
    process.exit(1);
    return;
  }
  console.log(`mongo-enable-auth: root user ${report.root}`);
  console.log(`mongo-enable-auth: app user ${report.app}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
