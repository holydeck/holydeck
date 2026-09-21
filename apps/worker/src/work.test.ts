import { expect, test } from 'vitest';

import { HANDLERS, handlersOn, workToDo } from './work.js';

import type { BackupProducerOptions } from './backup-producer.js';
import type { MediaIngestOptions } from './media-ingest.js';
import type { RestoreRehearsalOptions } from './restore-rehearsal.js';
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

test('this build registers media ingestion, backup production and restore rehearsal as its kinds of job', () => {
  expect(Object.keys(HANDLERS)).toEqual(['media-ingest', 'backup-run', 'restore-run']);
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

test('an entry point supplying its dependencies replaces every placeholder with a real handler', () => {
  const media = {
    context: undefined,
    media: {} as MediaIngestOptions['media'],
    storage: {} as MediaIngestOptions['storage'],
    mediaRoot: '/media',
    poster: {} as MediaIngestOptions['poster'],
  };
  const backupProducer = {
    context: undefined,
    archive: {} as BackupProducerOptions['archive'],
    db: {} as BackupProducerOptions['db'],
    restic: { repository: '/data/holydeck/restic' },
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
    restic: { repository: '/data/holydeck/restic' },
    schemaVersion: 1,
    now: () => '2026-09-21T00:00:00.000Z',
  };
  const handlers = handlersOn(media, backupProducer, restoreRehearsal);
  expect(Object.keys(handlers)).toEqual(['media-ingest', 'backup-run', 'restore-run']);
  expect(handlers['media-ingest']).not.toBe(HANDLERS['media-ingest']);
  expect(handlers['backup-run']).not.toBe(HANDLERS['backup-run']);
  expect(handlers['restore-run']).not.toBe(HANDLERS['restore-run']);
});
