// Drives mongo-enable-auth.mjs against a real, disposable mongo:8 volume — this repository has no
// existing Docker-Mongo test helper to reuse (scripts/workspace/compose.mjs only parses compose
// files as text, and scripts/stack/verify.mjs is a whole script, not an importable function), so
// this file hand-rolls the small amount of Docker plumbing it needs, matching verify.mjs's own
// execFileSync convention.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { DEFAULT_CONTAINER, ensureUsers, mongoExecArgs, run } from './mongo-enable-auth.mjs';

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' });

const cleanup = [];
after(() => {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      // best-effort teardown
    }
  }
});

const freshVolume = () => {
  const volume = `holydeck-test-mongo-enable-auth-${randomUUID()}`;
  docker(['volume', 'create', volume]);
  cleanup.push(() => docker(['volume', 'rm', '--force', volume]));
  return volume;
};

const uniqueContainer = (label) => `holydeck-test-mongo-enable-auth-${label}-${randomUUID()}`;

const waitForMongo = (container) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      docker(['exec', container, 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"]);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      execFileSync('sleep', ['0.5']);
    }
  }
};

/** Starts a plain, unauthenticated mongod bound to `volume` and left running — used to simulate the
 * real stack's own mongo container for the "refuses while in use" case. */
const startRunningMongo = (volume) => {
  const container = uniqueContainer('running');
  docker(['run', '--detach', '--name', container, '--volume', `${volume}:/data/db`, 'mongo:8']);
  cleanup.push(() => docker(['rm', '--force', container]));
  waitForMongo(container);
  return container;
};

/** Starts mongod with authentication enforced against `volume`'s already-created users, to verify
 * the credentials the script created actually work — the same way the real compose stack enforces
 * auth on restart. Left running; the caller stops it via the returned container name. */
const startAuthEnforcedMongo = (volume) => {
  const container = uniqueContainer('authed');
  docker([
    'run',
    '--detach',
    '--name',
    container,
    '--volume',
    `${volume}:/data/db`,
    'mongo:8',
    'mongod',
    '--auth',
    '--bind_ip_all',
  ]);
  cleanup.push(() => docker(['rm', '--force', container]));
  waitForMongo(container);
  return container;
};

const canAuthenticate = (container, db, user, password) => {
  try {
    docker([
      'exec',
      container,
      'mongosh',
      db,
      '-u',
      user,
      '-p',
      password,
      '--authenticationDatabase',
      db === 'admin' ? 'admin' : 'holydeck',
      '--quiet',
      '--eval',
      "db.adminCommand('ping')",
    ]);
    return true;
  } catch {
    return false;
  }
};

/** Pinging only proves authentication, not a role grant — any authenticated user can run it. A rehearsal
 * or a restore-apply needs to write, so this is the check that actually exercises the readWrite grant. */
const canWrite = (container, db, user, password) => {
  try {
    docker([
      'exec',
      container,
      'mongosh',
      db,
      '-u',
      user,
      '-p',
      password,
      '--authenticationDatabase',
      'holydeck',
      '--quiet',
      '--eval',
      "db.getCollection('mongo_enable_auth_smoke_test').insertOne({ ok: 1 })",
    ]);
    return true;
  } catch {
    return false;
  }
};

const unauthenticatedListDatabasesFails = (container) => {
  try {
    docker(['exec', container, 'mongosh', '--quiet', '--eval', "db.adminCommand('listDatabases')"]);
    return false;
  } catch {
    return true;
  }
};

test('a fresh unauthenticated volume gets both users created', () => {
  const volume = freshVolume();
  const container = uniqueContainer('migrate');
  const rootPassword = 'root-pw-not-a-real-secret';
  const appPassword = 'app-pw-not-a-real-secret';

  const report = run({
    env: { HOLYDECK_MONGO_ROOT_PASSWORD: rootPassword, HOLYDECK_MONGO_PASSWORD: appPassword },
    volume,
    container,
  });

  assert.deepEqual(report, { root: 'created', app: 'created' });

  const remaining = docker(['ps', '-a', '--filter', `name=${container}`, '--format', '{{.Names}}']).trim();
  assert.equal(remaining, '', 'the throwaway container is removed once the migration finishes');

  const check = startAuthEnforcedMongo(volume);
  assert.equal(canAuthenticate(check, 'admin', 'root', rootPassword), true);
  assert.equal(canAuthenticate(check, 'holydeck', 'holydeck', appPassword), true);
  assert.equal(
    canWrite(check, 'holydeck__restore_rehearsal', 'holydeck', appPassword),
    true,
    'the app user can write to the restore rehearsal database, which the weekly rehearsal and restore-apply need',
  );
  assert.equal(unauthenticatedListDatabasesFails(check), true);
});

test('re-running against an already-migrated volume is a no-op and never overwrites a password', () => {
  const volume = freshVolume();
  const originalRoot = 'original-root-pw-not-a-real-secret';
  const originalApp = 'original-app-pw-not-a-real-secret';

  const first = run({
    env: { HOLYDECK_MONGO_ROOT_PASSWORD: originalRoot, HOLYDECK_MONGO_PASSWORD: originalApp },
    volume,
    container: uniqueContainer('first'),
  });
  assert.deepEqual(first, { root: 'created', app: 'created' });

  const second = run({
    env: { HOLYDECK_MONGO_ROOT_PASSWORD: 'different-root-pw', HOLYDECK_MONGO_PASSWORD: 'different-app-pw' },
    volume,
    container: uniqueContainer('second'),
  });
  assert.deepEqual(second, {
    root: 'already exists (left untouched)',
    app: 'already exists (left untouched)',
  });

  const check = startAuthEnforcedMongo(volume);
  assert.equal(canAuthenticate(check, 'admin', 'root', originalRoot), true, 'the original root password still works');
  assert.equal(canAuthenticate(check, 'admin', 'root', 'different-root-pw'), false, 'the second call never wrote a new password');
  assert.equal(canAuthenticate(check, 'holydeck', 'holydeck', originalApp), true, 'the original app password still works');
});

test('refuses to run while a mongo container is already bound to the target volume', () => {
  const volume = freshVolume();
  startRunningMongo(volume);
  const container = uniqueContainer('should-not-start');

  assert.throws(
    () =>
      run({
        env: { HOLYDECK_MONGO_ROOT_PASSWORD: 'root-pw', HOLYDECK_MONGO_PASSWORD: 'app-pw' },
        volume,
        container,
      }),
    /already in use/,
  );

  const started = docker(['ps', '-a', '--filter', `name=${container}`, '--format', '{{.Names}}']).trim();
  assert.equal(started, '', 'the guard trips before the throwaway container is ever created');
});

test('never prints a password, including when a Docker command fails mid-migration', () => {
  // ensureUsers talks to a container name nothing ever started, so every docker exec inside it
  // fails immediately — this exercises the scrubbing path in mongo-enable-auth.mjs's docker()
  // helper without needing a slow, real failure partway through a live migration.
  const rootPassword = 'root-scrub-me-not-a-real-secret';
  const appPassword = 'app-scrub-me-not-a-real-secret';

  assert.throws(() => ensureUsers('holydeck-test-no-such-container', { rootPassword, appPassword }), (error) => {
    const text = `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    assert.equal(text.includes(rootPassword), false, 'root password must not appear in the error');
    assert.equal(text.includes(appPassword), false, 'app password must not appear in the error');
    return true;
  });
});

test('DEFAULT_CONTAINER is distinct from any test-only container name', () => {
  assert.equal(DEFAULT_CONTAINER.startsWith('holydeck-mongo-enable-auth'), true);
});

test('the docker exec argv mongosh runs under never carries a script or a secret', () => {
  // `mongoExecArgs` takes only a container name and a db name — there is no parameter it could
  // smuggle a password through, unlike the `-e KEY=VALUE` shape this replaced. Pinning its exact
  // output means a future edit that reintroduces an `-e` flag (or otherwise threads a script
  // argument into the argv) fails this test rather than only showing up in a `ps` listing.
  assert.deepEqual(mongoExecArgs('some-container', 'admin'), [
    'exec',
    '-i',
    'some-container',
    'sh',
    '-c',
    'f=$(mktemp) && cat > "$f" && mongosh "$1" --quiet "$f"; s=$?; rm -f "$f"; exit $s',
    'sh',
    'admin',
  ]);
});
