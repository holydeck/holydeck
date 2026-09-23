import { expect, test } from 'vitest';

import { HANDLERS, handlersOn, workToDo } from './work.js';

import type { BackupProducerOptions } from './backup-producer.js';
import type { MediaIngestOptions } from './media-ingest.js';
import type { MediaMigrationHandlerOptions } from './media-migration-handler.js';
import type { RestoreApplyHandlerOptions } from './restore-apply-handler.js';
import type { RestoreRehearsalOptions } from './restore-rehearsal.js';
import type { RetentionSweepOptions } from './retention-sweep-handler.js';
import type { Handler } from './runner.js';

const handler: Handler = async () => undefined;

test('a build with no handler registered claims nothing, and says that is why', () => {
  expect(workToDo({}, 'mongodb://127.0.0.1:27017/holydeck')).toEqual({
    runs: 'nothing',
    reason: 'no kind of job is registered in this build',
  });
});

test('a deployment keeping no durable records has no queue to claim from', () => {
  expect(workToDo({ 'media-probe': handler }, '')).toEqual({
    runs: 'nothing',
    reason: 'there is no durable store configured, so there is no queue to claim from',
  });
});

test('a registered handler and a store to claim from is work to do', () => {
  expect(workToDo({ 'media-probe': handler, 'backup-run': handler }, 'mongodb://127.0.0.1:27017/holydeck')).toEqual({
    runs: 'jobs',
    kinds: ['media-probe', 'backup-run'],
  });
});

test('this build registers media ingestion, backup production, restore rehearsal, restore-apply, retention sweep and media-root migration as its kinds of job', () => {
  expect(Object.keys(HANDLERS)).toEqual([
    'media-ingest', 'backup-run', 'restore-run', 'restore-apply', 'retention-sweep', 'media-root-migrate',
  ]);
});

test('the unconfigured media-ingest placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['media-ingest']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'media ingestion has not been configured',
  );
});

test('the unconfigured backup-run placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['backup-run']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'backup production has not been configured',
  );
});

test('the unconfigured restore-run placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['restore-run']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'restore rehearsal has not been configured',
  );
});

test('the unconfigured restore-apply placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['restore-apply']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'restore-apply has not been configured',
  );
});

test('the unconfigured retention-sweep placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['retention-sweep']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'retention sweep has not been configured',
  );
});

test('the unconfigured media-root-migrate placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['media-root-migrate']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'media storage-root migration has not been configured',
  );
});

test('an entry point supplying its dependencies replaces every placeholder with a real handler', () => {
  const media = {
    context: undefined,
    media: {} as MediaIngestOptions['media'],
    storage: {} as MediaIngestOptions['storage'],
    mediaRoot: () => '/media',
    poster: {} as MediaIngestOptions['poster'],
  };
  const backupProducer = {
    context: undefined,
    schedulerState: {} as BackupProducerOptions['schedulerState'],
    archive: {} as BackupProducerOptions['archive'],
    db: {} as BackupProducerOptions['db'],
    restic: { repository: '/data/holydeck/restic', password: 'p'.repeat(64) },
    settingsPath: '/data/holydeck/config/settings.yaml',
    mediaRoot: '/media',
    schemaVersion: 1,
    now: () => '2026-09-21T00:00:00.000Z',
  };
  const restoreRehearsal = {
    context: undefined,
    db: {} as RestoreRehearsalOptions['db'],
    target: {} as RestoreRehearsalOptions['target'],
    sessions: {} as RestoreRehearsalOptions['sessions'],
    capabilities: {} as RestoreRehearsalOptions['capabilities'],
    restic: { repository: '/data/holydeck/restic', password: 'p'.repeat(64) },
    schemaVersion: 1,
    now: () => '2026-09-21T00:00:00.000Z',
    schedulerState: {} as RestoreRehearsalOptions['schedulerState'],
  };
  const restoreApply = {
    context: undefined,
    db: {} as RestoreApplyHandlerOptions['db'],
    target: {} as RestoreApplyHandlerOptions['target'],
    sessions: {} as RestoreApplyHandlerOptions['sessions'],
    capabilities: {} as RestoreApplyHandlerOptions['capabilities'],
    maintenance: {} as RestoreApplyHandlerOptions['maintenance'],
    restic: { repository: '/data/holydeck/restic', password: 'p'.repeat(64) },
    settingsPath: '/data/holydeck/config/settings.yaml',
    mediaRoot: '/media',
    now: () => '2026-09-21T00:00:00.000Z',
  };
  const retentionSweep = {
    context: undefined,
    db: {} as RetentionSweepOptions['db'],
    autosaveRetentionDays: 30,
    auditRetentionDays: 400,
    notificationStore: {} as RetentionSweepOptions['notificationStore'],
    notificationReadRetentionDays: 30,
    now: () => '2026-09-21T00:00:00.000Z',
    schedulerState: {} as RetentionSweepOptions['schedulerState'],
  };
  const mediaMigration = {
    context: undefined,
    db: {} as MediaMigrationHandlerOptions['db'],
    maintenance: {} as MediaMigrationHandlerOptions['maintenance'],
    migrationState: {} as MediaMigrationHandlerOptions['migrationState'],
    loaded: {} as MediaMigrationHandlerOptions['loaded'],
    settingsIo: {} as MediaMigrationHandlerOptions['settingsIo'],
    now: () => '2026-09-21T00:00:00.000Z',
  };
  const handlers = handlersOn({
    mediaIngest: media, backupProducer, restoreRehearsal, restoreApply, retentionSweep, mediaMigration,
  });
  expect(Object.keys(handlers)).toEqual([
    'media-ingest', 'backup-run', 'restore-run', 'restore-apply', 'retention-sweep', 'media-root-migrate',
  ]);
  expect(handlers['media-ingest']).not.toBe(HANDLERS['media-ingest']);
  expect(handlers['backup-run']).not.toBe(HANDLERS['backup-run']);
  expect(handlers['restore-run']).not.toBe(HANDLERS['restore-run']);
  expect(handlers['restore-apply']).not.toBe(HANDLERS['restore-apply']);
  expect(handlers['retention-sweep']).not.toBe(HANDLERS['retention-sweep']);
  expect(handlers['media-root-migrate']).not.toBe(HANDLERS['media-root-migrate']);
});
