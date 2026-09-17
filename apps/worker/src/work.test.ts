import { expect, test } from 'vitest';

import { HANDLERS, handlersOn, workToDo } from './work.js';

import type { MediaIngestOptions } from './media-ingest.js';
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

test('this build registers media ingestion as its first kind of job', () => {
  expect(Object.keys(HANDLERS)).toEqual(['media-ingest']);
});

test('the unconfigured placeholder refuses to run a job until an entry point wires it up', async () => {
  await expect(HANDLERS['media-ingest']?.({} as never, new AbortController().signal)).rejects.toThrow(
    'media ingestion has not been configured',
  );
});

test('an entry point supplying its dependencies replaces the placeholder with a real handler', () => {
  const options = {
    context: undefined,
    media: {} as MediaIngestOptions['media'],
    storage: {} as MediaIngestOptions['storage'],
    mediaRoot: '/media',
    poster: {} as MediaIngestOptions['poster'],
  };
  const handlers = handlersOn(options);
  expect(Object.keys(handlers)).toEqual(['media-ingest']);
  expect(handlers['media-ingest']).not.toBe(HANDLERS['media-ingest']);
});
