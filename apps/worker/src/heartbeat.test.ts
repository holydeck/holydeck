import { DEFAULT_SETTINGS } from '@holydeck/app/settings';
import { describe, expect, it } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeatPath,
  heartbeatProblem,
  heartbeatText,
} from './heartbeat.js';
import { workerPaths } from './runtime.js';

const paths = workerPaths(DEFAULT_SETTINGS);
const AT = '2026-09-13T09:00:00.000Z';
const later = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();

describe('where the heartbeat is written', () => {
  it('sits under the data directory the worker already owns', () => {
    expect(heartbeatPath(paths)).toBe('/data/holydeck/worker/heartbeat.json');
  });

  it('follows the data directory rather than the default', () => {
    expect(heartbeatPath({ ...paths, dataDir: '/srv/holydeck' })).toBe('/srv/holydeck/worker/heartbeat.json');
  });

  it('is written often enough that a health check can believe it', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(HEARTBEAT_STALE_MS);
  });
});

describe('what the worker writes', () => {
  it('records when it was written, which process wrote it, and the paths it checked', () => {
    expect(JSON.parse(heartbeatText(AT, 41, paths))).toEqual({
      at: AT,
      pid: 41,
      paths: ['/data/holydeck', '/data/holydeck/media', '/data/holydeck/jobs', '/data/holydeck/spool'],
    });
  });

  it('ends with a newline, so the file reads as a line in a terminal', () => {
    expect(heartbeatText(AT, 41, paths).endsWith('\n')).toBe(true);
  });

  it('writes what the health check reads, with nothing between them to disagree about', () => {
    expect(heartbeatProblem(heartbeatText(AT, 41, paths), AT)).toBeUndefined();
  });
});

describe('judging a heartbeat', () => {
  const fresh = heartbeatText(AT, 41, paths);

  it('accepts one written just now', () => {
    expect(heartbeatProblem(fresh, later(1_000))).toBeUndefined();
  });

  it('accepts one written within the window it is given', () => {
    expect(heartbeatProblem(fresh, later(HEARTBEAT_STALE_MS - 1))).toBeUndefined();
  });

  it('refuses one older than the window', () => {
    expect(heartbeatProblem(fresh, later(HEARTBEAT_STALE_MS + 5_000))).toBe(
      'the last heartbeat was written 50s ago, and a healthy worker writes one every 10s',
    );
  });

  it('takes the window as an argument, so a slower deployment can say so', () => {
    expect(heartbeatProblem(fresh, later(60_000), 120_000)).toBeUndefined();
  });

  it('refuses a file that is not there, which is what a worker that never started leaves', () => {
    expect(heartbeatProblem(undefined, AT)).toBe('the worker has written no heartbeat yet');
  });

  it('refuses a file that is not readable', () => {
    expect(heartbeatProblem('{ half written', AT)).toBe('the heartbeat file is not readable');
  });

  it('refuses a file that is readable but is not a record', () => {
    expect(heartbeatProblem('[]', AT)).toBe('the heartbeat file is not readable');
  });

  it('refuses one that names no time it was written', () => {
    expect(heartbeatProblem('{"pid":41}', AT)).toBe('the heartbeat file names no time it was written');
  });

  it('refuses a time that is not a time', () => {
    expect(heartbeatProblem('{"at":"whenever"}', AT)).toBe('the heartbeat file names no time it was written');
  });

  it('refuses to judge against a clock it cannot read, rather than calling the worker unhealthy', () => {
    expect(heartbeatProblem(fresh, 'whenever')).toBe('the time to judge the heartbeat against is not a time');
  });

  it('accepts one written a moment ahead of the clock, because two containers are two clocks', () => {
    expect(heartbeatProblem(fresh, later(-2_000))).toBeUndefined();
  });

  it('refuses one written far ahead of the clock, because that is not skew', () => {
    expect(heartbeatProblem(fresh, later(-HEARTBEAT_STALE_MS - 5_000))).toBe(
      'the last heartbeat is dated 50s ahead of this clock',
    );
  });
});
