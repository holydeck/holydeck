import { describe, expect, it } from 'vitest';

import { parseMediaMigrationRequest } from './media-migration.js';

describe('what an operator asks when moving media storage to a new root', () => {
  it('accepts an absolute target root', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '/mnt/media-new' });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.targetRoot : undefined).toBe('/mnt/media-new');
  });

  it('refuses a request with no target root at all', () => {
    const parsed = parseMediaMigrationRequest({});
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });

  it('refuses an empty target root', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });

  it('refuses a relative target root', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: 'relative/path' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.message)).toContain(
      'must be an absolute filesystem path',
    );
  });

  it('refuses a target root with trailing whitespace', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '/mnt/media-new ' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });

  it('refuses the filesystem root itself', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '/' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });

  it('refuses a target root with a parent-directory segment', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '/mnt/media/../etc' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });

  it('refuses a target root with a trailing slash', () => {
    const parsed = parseMediaMigrationRequest({ targetRoot: '/mnt/media-new/' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('mediaMigration.targetRoot');
  });
});
