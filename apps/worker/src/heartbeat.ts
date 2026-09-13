// The worker serves no HTTP, so it says it is alive by writing a file the health check reads.
//
// A supervisor can only see a process that answers something. The worker already re-checks its mounts
// on a timer, which is the only work it does until the queue arrives, so it writes the result of that
// check where anything with the volume mounted can read it. Nothing here touches the filesystem: what a
// heartbeat says and how old is too old are decisions, and decisions are testable.

import type { WorkerPaths } from './runtime.js';

/** How often the worker writes one. Short enough that a health check need not wait a minute to believe it. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** How old a heartbeat may be before the worker counts as unhealthy: four missed writes. */
export const HEARTBEAT_STALE_MS = 45_000;

export const heartbeatPath = ({ dataDir }: WorkerPaths): string => `${dataDir}/worker/heartbeat.json`;

export function heartbeatText(at: string, pid: number, paths: WorkerPaths): string {
  return `${JSON.stringify({ at, pid, paths: Object.values(paths) }, undefined, 2)}\n`;
}

const seconds = (ms: number): number => Math.round(ms / 1000);

const timeIn = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : Number.NaN);

/**
 * Why the worker should not be called healthy, or nothing if it should. The heartbeat file is passed in
 * as text rather than read here, and `undefined` means there is no file — which is what a worker that
 * never got as far as its first mount check leaves behind.
 */
export function heartbeatProblem(
  text: string | undefined,
  now: string,
  staleAfterMs = HEARTBEAT_STALE_MS,
): string | undefined {
  if (text === undefined) return 'the worker has written no heartbeat yet';

  const nowMs = Date.parse(now);
  // Refusing to judge is not the same as judging the worker unhealthy: an unreadable clock is the
  // health check's own problem, and saying so is what makes it fixable.
  if (Number.isNaN(nowMs)) return 'the time to judge the heartbeat against is not a time';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'the heartbeat file is not readable';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the heartbeat file is not readable';
  }

  const at = timeIn((parsed as Record<string, unknown>)['at']);
  if (Number.isNaN(at)) return 'the heartbeat file names no time it was written';

  const age = nowMs - at;
  if (age > staleAfterMs) {
    return `the last heartbeat was written ${seconds(age)}s ago, and a healthy worker writes one every ${seconds(HEARTBEAT_INTERVAL_MS)}s`;
  }
  // Two containers are two clocks, so a heartbeat a little ahead of this one is skew rather than a fault.
  if (age < -staleAfterMs) return `the last heartbeat is dated ${seconds(-age)}s ahead of this clock`;
  return undefined;
}
