import { DEFAULT_SETTINGS, loadSettings } from '@holydeck/app/settings';
import { describe, expect, it } from 'vitest';

import { WorkerError, assertUsablePaths, workerPaths } from './runtime.js';

describe('the worker paths', () => {
  it('sits under the directories the shared settings name, not under its own', () => {
    const { values } = loadSettings({
      env: { HOLYDECK_DATA_DIR: '/srv/holydeck', HOLYDECK_MEDIA_ROOT: '/srv/media' },
    });

    expect(workerPaths(values)).toEqual({
      dataDir: '/srv/holydeck',
      mediaRoot: '/srv/media',
      jobsDir: '/srv/holydeck/jobs',
      spoolDir: '/srv/holydeck/spool',
    });
  });

  it('defaults with the application, because both run the same image', () => {
    expect(workerPaths(DEFAULT_SETTINGS)).toEqual({
      dataDir: '/data/holydeck',
      mediaRoot: '/data/holydeck/media',
      jobsDir: '/data/holydeck/jobs',
      spoolDir: '/data/holydeck/spool',
    });
  });
});

describe('refusing to start on paths it cannot write', () => {
  const paths = workerPaths(DEFAULT_SETTINGS);

  it('says nothing when every path is writable', () => {
    expect(() => assertUsablePaths(() => true, paths)).not.toThrow();
  });

  it('names every unwritable path at once, so one pass fixes the mount', () => {
    const writable = (path: string): boolean => path === '/data/holydeck';

    try {
      assertUsablePaths(writable, paths);
      expect.unreachable('an unwritable path must stop the worker');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).problems).toEqual([
        '/data/holydeck/media: not writable',
        '/data/holydeck/jobs: not writable',
        '/data/holydeck/spool: not writable',
      ]);
    }
  });
});
