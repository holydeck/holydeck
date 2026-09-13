// Brings both Compose stacks up for real and reads what they actually did. The file checks in
// scripts/workspace/compose.mjs say the stacks are arranged correctly; this says they work, which is a
// different claim and the one FND-06 asks for: every service health-checked and up, the development
// stack keeping its records across a down and an up, and the test stack keeping nothing a second run
// could find.
//
//   node scripts/stack/verify.mjs          # or: pnpm verify:stack
//
// It builds images, so the first run is slow and the rest are cache. It ends by taking both stacks down
// with their volumes, including when a check fails, so a failed run leaves nothing running.
//
// Every phase is printed as it happens, because this script is also the evidence: what it wrote is what
// the stack did on the machine it was run on.

import { execFileSync } from 'node:child_process';

import { DEV_FILE, TEST_FILE, healthVerdicts } from '../workspace/compose.mjs';
import { fromRepoRoot } from '../workspace/pipeline.mjs';

const SERVICES = ['app', 'server', 'web', 'worker'];

const root = fromRepoRoot('.');
const failures = [];

const say = (line) => process.stdout.write(`${line}\n`);

const compose = (file, args, capture = false) =>
  execFileSync('docker', ['compose', '-f', file, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });

// The migration exits when it is done, so the services are named rather than the stack: Compose waits for
// each named service to be healthy and for what they depend on to have finished successfully.
const up = (file) => compose(file, ['up', '--build', '--wait', '--wait-timeout', '900', ...SERVICES]);

const down = (file, { volumes }) =>
  compose(file, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])]);

const mongo = (file, script) =>
  compose(file, ['exec', '-T', 'mongo', 'mongosh', 'holydeck', '--quiet', '--eval', script], true).trim();

const check = (claim, ok, detail) => {
  if (!ok) failures.push(claim);
  say(`${ok ? '  ok  ' : ' FAIL '} ${claim}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`);
};

// --all, because the migration has exited by the time the stack is up and `ps` lists only what runs.
const healthy = (file) => {
  const problems = healthVerdicts(compose(file, ['ps', '--all', '--format', 'json'], true));
  check(`${file}: every service is up, health-checked and the migration finished`, problems.length === 0, problems.join('; '));
};

const ledger = (file) => ({
  rows: Number(mongo(file, 'db.schema_migrations.countDocuments()')),
  applied: mongo(file, 'db.schema_migrations.findOne({ _id: "v1.up.1.done" })?.at ?? "none"'),
});

const probes = (file) => Number(mongo(file, 'db.stack_probe.countDocuments()'));

const markProbe = (file, id) => mongo(file, `db.stack_probe.insertOne({ _id: "${id}" }).acknowledged`);

try {
  say(`\n=== ${DEV_FILE}: first bring-up ===`);
  up(DEV_FILE);
  healthy(DEV_FILE);
  const first = ledger(DEV_FILE);
  check(`${DEV_FILE}: the migration recorded version 1 as applied`, first.rows === 2 && first.applied !== 'none', `${first.rows} ledger rows, applied at ${first.applied}`);
  markProbe(DEV_FILE, 'before-restart');
  check(`${DEV_FILE}: a record written into the stack is there`, probes(DEV_FILE) === 1);

  say(`\n=== ${DEV_FILE}: down and up again, volumes kept ===`);
  down(DEV_FILE, { volumes: false });
  up(DEV_FILE);
  healthy(DEV_FILE);
  const kept = ledger(DEV_FILE);
  check(`${DEV_FILE}: the ledger survived the restart rather than being written again`, kept.rows === 2 && kept.applied === first.applied, `${kept.rows} rows, applied at ${kept.applied}`);
  check(`${DEV_FILE}: the record written before the restart is still there`, probes(DEV_FILE) === 1);

  say(`\n=== ${DEV_FILE}: down with volumes, then up ===`);
  down(DEV_FILE, { volumes: true });
  up(DEV_FILE);
  healthy(DEV_FILE);
  const wiped = ledger(DEV_FILE);
  check(`${DEV_FILE}: the migration ran against an empty database and recorded it again`, wiped.rows === 2 && wiped.applied !== first.applied, `applied at ${wiped.applied}, was ${first.applied}`);
  check(`${DEV_FILE}: nothing the volumes held survived down --volumes`, probes(DEV_FILE) === 0);

  say(`\n=== ${TEST_FILE}: first run ===`);
  up(TEST_FILE);
  healthy(TEST_FILE);
  const testFirst = ledger(TEST_FILE);
  check(`${TEST_FILE}: the test stack migrated its own database`, testFirst.rows === 2, `${testFirst.rows} ledger rows`);
  markProbe(TEST_FILE, 'first-run');
  check(`${TEST_FILE}: the first run wrote its record`, probes(TEST_FILE) === 1);

  say(`\n=== ${TEST_FILE}: second run, volumes kept ===`);
  down(TEST_FILE, { volumes: false });
  up(TEST_FILE);
  healthy(TEST_FILE);
  check(`${TEST_FILE}: the second run does not see what the first run wrote`, probes(TEST_FILE) === 0);
  const testSecond = ledger(TEST_FILE);
  check(`${TEST_FILE}: the second run migrated an empty database of its own`, testSecond.rows === 2 && testSecond.applied !== testFirst.applied, `applied at ${testSecond.applied}, was ${testFirst.applied}`);
} finally {
  say('\n=== taking both stacks down with their volumes ===');
  for (const file of [DEV_FILE, TEST_FILE]) {
    try {
      down(file, { volumes: true });
    } catch (error) {
      say(` FAIL  ${file}: could not be taken down — ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
      failures.push(`${file}: could not be taken down`);
    }
  }
}

say(failures.length === 0 ? '\nboth stacks verified' : `\n${failures.length} claim(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
