// What a worker does with the process it was started as.
//
// There are two answers and neither is this file's to choose: a build with no handler registered has no
// kind of work to claim, and a deployment keeping no durable records has no queue to claim it from. Both
// leave a worker watching its mounts instead, which is worth doing on its own and is what the health
// check reads. The decision lives here rather than in the entry point so that both answers are read back
// by a test, since an entry point is only ever run by running the worker.

import type { Handler } from './runner.js';

export type Handlers = Readonly<Record<string, Handler>>;

/**
 * The kinds of job this build knows how to run. Empty until a task registers one — media ingestion is the
 * first — and a worker with nothing registered parks rather than leasing work it would only fail.
 */
export const HANDLERS: Handlers = Object.freeze({});

export type Work =
  | { readonly runs: 'jobs'; readonly kinds: readonly string[] }
  | { readonly runs: 'nothing'; readonly reason: string };

export function workToDo(handlers: Handlers, mongoUrl: string): Work {
  const kinds = Object.keys(handlers);
  if (kinds.length === 0) return { runs: 'nothing', reason: 'no kind of job is registered in this build' };
  if (mongoUrl === '') {
    return { runs: 'nothing', reason: 'there is no durable store configured, so there is no queue to claim from' };
  }
  return { runs: 'jobs', kinds };
}
