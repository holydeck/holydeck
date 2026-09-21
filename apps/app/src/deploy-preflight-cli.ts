// The deployment preflight, run deliberately before a deployment begins — not from inside a container's
// own start-up, the same discipline migrate.ts already keeps for the schema change it runs. Prints every
// configuration, migration and backup problem it finds, all at once, and exits non-zero if deploying now
// would be a mistake.

import { readFileSync } from 'node:fs';

import { MongoClient } from 'mongodb';

import { backupContext, recordedBackups } from './backups.js';
import { checkOwnSettingsMount, readSettingsText } from './boot.js';
import { systemContext } from './context.js';
import { deployPreflight } from './deploy-preflight.js';
import { schemaStatus } from './migrations.js';
import { repositoryDb } from './repositories.js';
import { SettingsError, loadSettings, settingsPath } from './settings.js';

import type { PreflightResult } from './deploy-preflight.js';

const path = settingsPath(process.env);
checkOwnSettingsMount(path);
const configuration = {
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
};

let settings;
try {
  settings = loadSettings(configuration);
} catch (error) {
  if (!(error instanceof SettingsError)) throw error;
  for (const problem of error.problems) process.stderr.write(`configuration: ${problem}\n`);
  process.exit(1);
}

if (settings.values.mongoUrl === '') {
  process.stderr.write('there is no durable store configured, so migration and backup readiness cannot be checked\n');
  process.exit(2);
}

const client = new MongoClient(settings.values.mongoUrl, { ignoreUndefined: true });
await client.connect();

try {
  const db = repositoryDb(client.db());
  const correlationId = `deploy-preflight:${process.pid}`;
  const schema = await schemaStatus(db, systemContext(correlationId));
  const backups = await recordedBackups(db, backupContext('system', correlationId));
  const report = deployPreflight({ configuration, schema, backups });
  const checks: readonly (readonly [string, PreflightResult])[] = [
    ['configuration', report.configuration],
    ['migration', report.migration],
    ['backup', report.backup],
  ];
  for (const [name, result] of checks) {
    if (result.ok) {
      process.stdout.write(`${name}: ready\n`);
    } else {
      for (const problem of result.problems) process.stderr.write(`${name}: ${problem}\n`);
    }
  }
  process.exit(report.ok ? 0 : 1);
} finally {
  await client.close();
}
