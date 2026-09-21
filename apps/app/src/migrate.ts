// The migration command, run deliberately and never by a container starting up: a schema change that
// happens while nobody is watching is a schema change nobody knows to roll back. `--rollback` undoes the
// newest applied version, or recovers the one a failed run left half applied.

import { readFileSync } from 'node:fs';

import { MongoClient } from 'mongodb';

import { checkSettingsMount, mountedPaths, readMountInfo, readSettingsText } from './boot.js';
import { systemContext } from './context.js';
import { SCHEMA_VERSION, migrate, rollback, schemaStatus } from './migrations.js';
import { repositoryDb } from './repositories.js';
import { loadSettings, settingsPath } from './settings.js';

const path = settingsPath(process.env);
checkSettingsMount(path, mountedPaths(readMountInfo((file) => readFileSync(file, 'utf8')) ?? ''));
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

if (settings.values.mongoUrl === '') {
  process.stderr.write('there is no durable store configured, so there is nothing to migrate\n');
  process.exit(2);
}

const undo = process.argv.includes('--rollback');
const client = new MongoClient(settings.values.mongoUrl, { ignoreUndefined: true });
await client.connect();

try {
  const db = repositoryDb(client.db());
  const context = systemContext(`migrate:${process.pid}`);
  const now = (): string => new Date().toISOString();
  const before = await schemaStatus(db, context);
  process.stdout.write(`schema version ${before.recorded}, this build needs ${SCHEMA_VERSION}\n`);
  const after = undo ? await rollback(db, context, { now }) : await migrate(db, context, { now });
  process.stdout.write(`schema version ${after.recorded}\n`);
} finally {
  await client.close();
}
