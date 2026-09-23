// Brings all three Compose stacks up for real and reads what they actually did. The file checks in
// scripts/workspace/compose.mjs say the stacks are arranged correctly; this says they work, which is a
// different claim and the one FND-06 asks for: every service health-checked and up, the development
// stack keeping its records across a down and an up, the test stack keeping nothing a second run could
// find, and the supported deployment reaching a usable seeded instance from an empty volume set.
//
//   node scripts/stack/verify.mjs          # or: pnpm verify:stack
//
// It builds images, so the first run is slow and the rest are cache. It ends by taking every stack down
// with its volumes, including when a check fails, so a failed run leaves nothing running.
//
// Every phase is printed as it happens, because this script is also the evidence: what it wrote is what
// the stack did on the machine it was run on.

import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';

import { DEPLOY_FILE, DEPLOY_SERVICES, DEV_FILE, TEST_FILE, healthVerdicts } from '../workspace/compose.mjs';
import { fromRepoRoot } from '../workspace/pipeline.mjs';

const DEV_TOP_SERVICES = ['app', 'server', 'web', 'worker'];

// No web: the deployment image already has the client baked in, so there is no separate service to wait
// on. No migrate or mongo either, the same as the development list — both start as dependencies of the
// services named here, and --wait follows their depends_on conditions rather than needing them spelled out.
const DEPLOY_TOP_SERVICES = ['app', 'server', 'worker'];

// compose.yaml requires these and has no dev-token/dev-password fallback; nothing this script does is a
// real deployment, so fixed placeholders are enough to bring it up for verification.
const DEPLOY_TOKEN = 'stack-verify-corpus-token-not-a-secret';
const DEPLOY_MONGO_ROOT_PASSWORD = 'stack-verify-mongo-root-not-a-secret';
const DEPLOY_MONGO_PASSWORD = 'stack-verify-mongo-app-not-a-secret';

const ENV_FOR = Object.freeze({
  [DEPLOY_FILE]: {
    HOLYDECK_CORPUS_TOKEN: DEPLOY_TOKEN,
    HOLYDECK_MONGO_ROOT_PASSWORD: DEPLOY_MONGO_ROOT_PASSWORD,
    HOLYDECK_MONGO_PASSWORD: DEPLOY_MONGO_PASSWORD,
  },
});

// Every stack now runs mongo with authentication on (OPS's Mongo-auth change), so the app-user password
// this script uses to inspect each database directly must match what each compose file actually applied:
// compose.dev.yaml's own `:-` default (this script never overrides it), compose.test.yaml's hardcoded
// literal, and the DEPLOY_MONGO_PASSWORD this script sets above.
const MONGO_PASSWORD_FOR = Object.freeze({
  [DEV_FILE]: 'dev-mongo-app-not-a-secret',
  [TEST_FILE]: 'test-mongo-password-not-a-secret',
  [DEPLOY_FILE]: DEPLOY_MONGO_PASSWORD,
});

// What "a usable seeded instance" (T59, SEED-01) means: the content-language registry, the slide-label
// catalogue, the built-in slide layouts and the default service template are all non-empty. slide_groups
// is not checked here — the default Standby screen is built on the generic revisions shape, not its own
// top-level collection.
const SEEDED_COLLECTIONS = ['content_languages', 'service_templates', 'slide_labels', 'slide_layouts'];

// DEPL-02's reference posture: only the application is exposed. compose.yaml publishes nothing for these
// three, so nothing outside the deployment can even name a host port to try — checked here against what
// Docker actually did, which is the only place a stack's real exposure can be read from.
const UNPUBLISHED_SERVICES = ['mongo', 'server', 'worker'];

// The port each service would answer on if it were published, so a dial from this host is asking the same
// question an outside caller would ask. worker has no port of its own — it serves no HTTP at all — so its
// exposure is checked only through UNPUBLISHED_SERVICES above.
const WELL_KNOWN_PORT = { mongo: 27017, server: 3000 };

const DIAL_TIMEOUT_MS = 2000;

const root = fromRepoRoot('.');
const failures = [];

const say = (line) => process.stdout.write(`${line}\n`);

const compose = (file, args, capture = false) =>
  execFileSync('docker', ['compose', '-f', file, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...ENV_FOR[file] },
  });

const topServices = (file) => (file === DEPLOY_FILE ? DEPLOY_TOP_SERVICES : DEV_TOP_SERVICES);

// The migration exits when it is done, so the services are named rather than the stack: Compose waits for
// each named service to be healthy and for what they depend on to have finished successfully.
const up = (file) => compose(file, ['up', '--build', '--wait', '--wait-timeout', '900', ...topServices(file)]);

const down = (file, { volumes }) =>
  compose(file, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])]);

const mongo = (file, script) =>
  compose(
    file,
    [
      'exec', '-T', 'mongo', 'mongosh', 'holydeck',
      '-u', 'holydeck', '-p', MONGO_PASSWORD_FOR[file], '--authenticationDatabase', 'holydeck',
      '--quiet', '--eval', script,
    ],
    true,
  ).trim();

const check = (claim, ok, detail) => {
  if (!ok) failures.push(claim);
  say(`${ok ? '  ok  ' : ' FAIL '} ${claim}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`);
};

// --all, because the migration has exited by the time the stack is up and `ps` lists only what runs.
// The deployment stack starts no web service, so it is checked against its own required-service list.
const healthy = (file) => {
  const problems = healthVerdicts(
    compose(file, ['ps', '--all', '--format', 'json'], true),
    file === DEPLOY_FILE ? DEPLOY_SERVICES : undefined,
  );
  check(`${file}: every service is up, health-checked and the migration finished`, problems.length === 0, problems.join('; '));
};

// The mongo healthcheck itself already refuses to report healthy until an unauthenticated
// `listDatabases` fails (see each compose file's own comment), so a passing `healthy(file)`
// already implies this — but only as a side effect of a liveness check. This asserts it as its
// own named, legible claim: attempting the same unauthenticated call directly and requiring it
// to fail, rather than leaving auth enforcement to be inferred from why health passed.
const refusesUnauthenticated = (file) => {
  let refused = false;
  try {
    compose(file, ['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', 'db.adminCommand("listDatabases")'], true);
  } catch {
    refused = true;
  }
  check(`${file}: mongo refuses an unauthenticated connection`, refused);
};

const ledger = (file) => ({
  rows: Number(mongo(file, 'db.schema_migrations.countDocuments()')),
  applied: mongo(file, 'db.schema_migrations.findOne({ _id: "v1.up.1.done" })?.at ?? "none"'),
});

const probes = (file) => Number(mongo(file, 'db.stack_probe.countDocuments()'));

const markProbe = (file, id) => mongo(file, `db.stack_probe.insertOne({ _id: "${id}" }).acknowledged`);

const seeded = (file) => {
  const counts = Object.fromEntries(
    SEEDED_COLLECTIONS.map((collection) => [collection, Number(mongo(file, `db.${collection}.countDocuments()`))]),
  );
  const empty = Object.entries(counts)
    .filter(([, count]) => count === 0)
    .map(([collection]) => collection);
  check(
    `${file}: a cold start reaches a usable seeded instance`,
    empty.length === 0,
    empty.length === 0
      ? Object.entries(counts)
          .map(([collection, count]) => `${collection}=${count}`)
          .join(', ')
      : `empty: ${empty.join(', ')}`,
  );
};

/** Whether a TCP connection to this host's port succeeds within a short timeout — the same question an
 *  outside caller is asking when it tries to reach a service this stack did not publish. */
const reaches = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(DIAL_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

/** What Docker actually published for one service, read the way `docker compose ps` reports it — a
 *  stack is exposed by what it started, not by what compose.yaml merely declares. Docker lists a
 *  Publishers entry for every port the image's Dockerfile EXPOSEs, too, even when compose.yaml never
 *  binds it to the host — that entry carries PublishedPort 0 and an empty URL, and is not an exposure;
 *  apps/app/Dockerfile's own EXPOSE is what makes worker (built from that same image) show one. Only a
 *  nonzero PublishedPort means a caller outside the deployment has a host port to try. */
const publishersOf = (file, service) => {
  const text = compose(file, ['ps', '--all', '--format', 'json'], true).trim();
  const rows = text.startsWith('[')
    ? JSON.parse(text)
    : text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
  const publishers = rows.find((row) => row.Service === service)?.Publishers ?? [];
  return publishers.filter((entry) => entry.PublishedPort > 0);
};

// The one live check this file exists to add on top of DEPL-01's: not just that the stack came up, but
// that the only door left open once it did is the application's.
const reachability = async (file) => {
  for (const service of UNPUBLISHED_SERVICES) {
    const published = publishersOf(file, service);
    check(
      `${file}: ${service} publishes no port a caller outside the deployment could reach`,
      published.length === 0,
      published.map((entry) => `${entry.URL}:${entry.PublishedPort}`).join(', '),
    );
  }
  for (const [service, port] of Object.entries(WELL_KNOWN_PORT)) {
    check(
      `${file}: ${service}'s own port ${port} refuses a connection made from outside the deployment`,
      !(await reaches(port)),
    );
  }
  const applicationAnswers = await fetch('http://127.0.0.1:3100/health').then(
    (response) => response.ok,
    () => false,
  );
  check(`${file}: the application answers its own health route from outside the deployment`, applicationAnswers);
};

try {
  say(`\n=== ${DEV_FILE}: first bring-up ===`);
  up(DEV_FILE);
  healthy(DEV_FILE);
  refusesUnauthenticated(DEV_FILE);
  const first = ledger(DEV_FILE);
  // Not an exact row count, for the same reason the DEPLOY_FILE check below already avoids one: the
  // migration set has grown since this was written for a single migration.
  check(`${DEV_FILE}: the migration recorded version 1 as applied`, first.rows > 0 && first.applied !== 'none', `${first.rows} ledger rows, applied at ${first.applied}`);
  markProbe(DEV_FILE, 'before-restart');
  check(`${DEV_FILE}: a record written into the stack is there`, probes(DEV_FILE) === 1);

  say(`\n=== ${DEV_FILE}: down and up again, volumes kept ===`);
  down(DEV_FILE, { volumes: false });
  up(DEV_FILE);
  healthy(DEV_FILE);
  const kept = ledger(DEV_FILE);
  check(`${DEV_FILE}: the ledger survived the restart rather than being written again`, kept.rows === first.rows && kept.applied === first.applied, `${kept.rows} rows, applied at ${kept.applied}`);
  check(`${DEV_FILE}: the record written before the restart is still there`, probes(DEV_FILE) === 1);

  say(`\n=== ${DEV_FILE}: down with volumes, then up ===`);
  down(DEV_FILE, { volumes: true });
  up(DEV_FILE);
  healthy(DEV_FILE);
  const wiped = ledger(DEV_FILE);
  check(`${DEV_FILE}: the migration ran against an empty database and recorded it again`, wiped.rows === first.rows && wiped.applied !== first.applied, `applied at ${wiped.applied}, was ${first.applied}`);
  check(`${DEV_FILE}: nothing the volumes held survived down --volumes`, probes(DEV_FILE) === 0);

  say(`\n=== ${TEST_FILE}: first run ===`);
  up(TEST_FILE);
  healthy(TEST_FILE);
  refusesUnauthenticated(TEST_FILE);
  const testFirst = ledger(TEST_FILE);
  check(`${TEST_FILE}: the test stack migrated its own database`, testFirst.rows > 0, `${testFirst.rows} ledger rows`);
  markProbe(TEST_FILE, 'first-run');
  check(`${TEST_FILE}: the first run wrote its record`, probes(TEST_FILE) === 1);

  say(`\n=== ${TEST_FILE}: second run, volumes kept ===`);
  down(TEST_FILE, { volumes: false });
  up(TEST_FILE);
  healthy(TEST_FILE);
  check(`${TEST_FILE}: the second run does not see what the first run wrote`, probes(TEST_FILE) === 0);
  const testSecond = ledger(TEST_FILE);
  check(`${TEST_FILE}: the second run migrated an empty database of its own`, testSecond.rows === testFirst.rows && testSecond.applied !== testFirst.applied, `applied at ${testSecond.applied}, was ${testFirst.applied}`);

  say(`\n=== ${DEPLOY_FILE}: cold start on an empty volume set ===`);
  // The development stack is still up from the section above, and its app service publishes the same
  // host port 3100 the deployment stack's app service does — a real cold start has nothing else running.
  down(DEV_FILE, { volumes: true });
  down(DEPLOY_FILE, { volumes: true });
  up(DEPLOY_FILE);
  healthy(DEPLOY_FILE);
  refusesUnauthenticated(DEPLOY_FILE);
  const deployed = ledger(DEPLOY_FILE);
  // Not an exact row count: there is no prior run on this stack to compare against, and hardcoding
  // today's migration count would only go stale as the migration set grows. What "ran against an empty
  // database and recorded it" needs is that something was written at all.
  check(`${DEPLOY_FILE}: the migration ran against an empty database and recorded it`, deployed.rows > 0 && deployed.applied !== 'none', `${deployed.rows} ledger rows, applied at ${deployed.applied}`);
  seeded(DEPLOY_FILE);

  say(`\n=== ${DEPLOY_FILE}: only the application is reachable from outside the deployment ===`);
  await reachability(DEPLOY_FILE);
} finally {
  say('\n=== taking every stack down with its volumes ===');
  for (const file of [DEV_FILE, TEST_FILE, DEPLOY_FILE]) {
    try {
      down(file, { volumes: true });
    } catch (error) {
      say(` FAIL  ${file}: could not be taken down — ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
      failures.push(`${file}: could not be taken down`);
    }
  }
}

say(failures.length === 0 ? '\nall three stacks verified' : `\n${failures.length} claim(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
