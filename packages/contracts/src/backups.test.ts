import { describe, expect, it } from 'vitest';

import { parseBackupProduction } from './backups.js';

// Mirrors the valid fixture and the counterexamples backup-manifest.v1.json carries for `manifest` and
// `consistency` — the two sections a backup run itself produces. The other three sections belong to
// whatever restores one, and are out of scope here.
const production = () => ({
  manifest: {
    id: 'backup-2026-09-19T02-00-00Z',
    createdAt: '2026-09-19T02:00:00Z',
    schemaVersion: 19,
    contents: [
      { class: 'services', count: 42, bytes: 1_048_576, hash: 'sha256:abc' },
      { class: 'settings', count: 1, bytes: 4_096, hash: 'sha256:def' },
    ],
    excludedSecrets: ['session-keys', 'credential-hashes', 'api-tokens', 'signing-keys'],
  },
  consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
});

describe('what a backup run itself produces', () => {
  it('accepts a manifest with hash-addressed contents read at one snapshot', () => {
    const parsed = parseBackupProduction(production());
    expect(parsed.ok).toBe(true);
  });

  it('refuses a manifest that lists no contents', () => {
    const input = production();
    const parsed = parseBackupProduction({ ...input, manifest: { ...input.manifest, contents: [] } });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('backup.manifest.contents');
  });

  it('refuses a content class with no hash', () => {
    const input = production();
    const parsed = parseBackupProduction({
      ...input,
      manifest: { ...input.manifest, contents: [{ class: 'services', count: 1, bytes: 1, hash: '' }] },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('backup.manifest.contents.0.hash');
  });

  it('refuses a backup that excludes no secrets', () => {
    const input = production();
    const parsed = parseBackupProduction({ ...input, manifest: { ...input.manifest, excludedSecrets: [] } });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('backup.manifest.excludedSecrets');
  });

  it('refuses a secret that is both excluded and included', () => {
    const input = production();
    const parsed = parseBackupProduction({
      ...input,
      manifest: { ...input.manifest, excludedSecrets: ['session-keys', 'services'] },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.message)).toContain('services is both excluded and included');
  });

  it('refuses a backup that is not point-in-time consistent', () => {
    const input = production();
    const parsed = parseBackupProduction({ ...input, consistency: { ...input.consistency, pointInTime: false } });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.message)).toContain('is not point-in-time consistent');
  });

  it('reports every problem in one pass rather than the first', () => {
    const parsed = parseBackupProduction({
      manifest: { id: '', createdAt: '', schemaVersion: 1, contents: [], excludedSecrets: [] },
      consistency: { pointInTime: false, method: '' },
    });
    expect(parsed.ok).toBe(false);
    const paths = parsed.ok ? [] : parsed.problems.map((problem) => problem.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'backup.manifest.id',
        'backup.manifest.createdAt',
        'backup.manifest.contents',
        'backup.manifest.excludedSecrets',
        'backup.consistency.pointInTime',
        'backup.consistency.method',
      ]),
    );
  });
});
