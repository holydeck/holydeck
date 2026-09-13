import { expect, test } from 'vitest';

import { HANDLERS, workToDo } from './work.js';

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

test('this build registers no kind of job, which the task adding the first one changes here', () => {
  expect(Object.keys(HANDLERS)).toEqual([]);
});
