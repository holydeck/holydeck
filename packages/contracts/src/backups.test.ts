import { describe, expect, it } from 'vitest';

import {
  RESTORE_CLASSES,
  parseBackupManifest,
  parseBackupProduction,
  parseBackupRequest,
  parseRestoreRequest,
  parseRestoreSelection,
} from './backups.js';

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

// The whole of backup-manifest.v1.json, not only the half a producer writes: the valid fixture and every
// counterexample it carries for `integrity`, `objectives` and `restore` — the three sections that exist
// because somebody restored the backup and measured what it cost.
const restored = () => ({
  ...production(),
  integrity: {
    verifiedBeforeRestore: true,
    algorithm: 'sha256 per content class plus a manifest digest',
    mismatchAborts: true,
  },
  objectives: { rpoMinutes: 60, rtoMinutes: 240, measured: { rpoMinutes: 15, rtoMinutes: 96 } },
  restore: {
    sessionsInvalidated: true,
    capabilitiesInvalidated: true,
    rollback: {
      plan: 'Keep the pre-restore volume for 14 days and re-point at it; no restored write is destructive.',
      verified: true,
      verifiedOn: '2026-09-12',
    },
  },
});

const messagesOf = (parsed: ReturnType<typeof parseBackupManifest>): readonly string[] =>
  parsed.ok ? [] : parsed.problems.map((problem) => problem.message);

const pathsOf = (parsed: ReturnType<typeof parseBackupManifest>): readonly string[] =>
  parsed.ok ? [] : parsed.problems.map((problem) => problem.path);

describe('what a verified restore proves about a backup', () => {
  it('accepts a manifest whose restore was verified, timed and session-invalidating', () => {
    const parsed = parseBackupManifest(restored());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.objectives.measured : undefined).toEqual({ rpoMinutes: 15, rtoMinutes: 96 });
    expect(parsed.ok ? parsed.value.restore.rollback.verifiedOn : undefined).toBe('2026-09-12');
  });

  // "Ended every session" and "ended none because there were none" are different things to have proved,
  // and only a count tells them apart. Optional, so a manifest written before anyone counted still parses.
  it('records how many sessions the restore ended, when the rehearsal counted them', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      restore: { ...input.restore, sessionsInvalidatedCount: 40 },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.restore.sessionsInvalidatedCount : undefined).toBe(40);
    expect(parseBackupManifest(input).ok).toBe(true);
  });

  // A capability outlives no restore either: it is invalidated for the same reason a session is, and
  // counted the same way — "revoked six" and "found none to revoke" are different things to have proved.
  it('records how many capabilities the restore revoked, when the rehearsal counted them', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      restore: { ...input.restore, capabilitiesInvalidatedCount: 6 },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.restore.capabilitiesInvalidatedCount : undefined).toBe(6);
    expect(parseBackupManifest(input).ok).toBe(true);
  });

  it('accepts a rollback whose verification date was not recorded', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      restore: { ...input.restore, rollback: { plan: input.restore.rollback.plan, verified: true } },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.restore.rollback.verifiedOn : 'unset').toBeUndefined();
  });

  it('still refuses everything a backup run alone would be refused for', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, manifest: { ...input.manifest, contents: [] } });
    expect(parsed.ok).toBe(false);
    expect(pathsOf(parsed)).toContain('backup.manifest.contents');
  });

  it('refuses a restore that does not verify integrity first', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, integrity: { ...input.integrity, verifiedBeforeRestore: false } });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('did not verify integrity first');
  });

  it('refuses a restore that continues past an integrity mismatch', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, integrity: { ...input.integrity, mismatchAborts: false } });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('continues past an integrity mismatch');
  });

  it('refuses a restore naming no integrity algorithm', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, integrity: { ...input.integrity, algorithm: '' } });
    expect(parsed.ok).toBe(false);
    expect(pathsOf(parsed)).toContain('backup.integrity.algorithm');
  });

  it('refuses a recovery objective that was never measured', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      objectives: { ...input.objectives, measured: { rpoMinutes: 15 } },
    });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('was never measured');
    expect(pathsOf(parsed)).toContain('backup.objectives.measured.rtoMinutes');
  });

  it('refuses a measured recovery time that misses its target', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      objectives: { ...input.objectives, measured: { rpoMinutes: 15, rtoMinutes: 600 } },
    });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('measured rtoMinutes misses its target');
  });

  // The recovery point is decided by how often backups are taken, not by whether restoring one works, so
  // it is a figure the manifest records rather than a bound it is refused against — see `parseObjectives`.
  it('accepts a measured recovery point older than the target, which is recorded and not enforced', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      objectives: { ...input.objectives, measured: { rpoMinutes: 2880, rtoMinutes: 96 } },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.objectives.measured.rpoMinutes : undefined).toBe(2880);
  });

  it('refuses a restore that left existing sessions valid', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, restore: { ...input.restore, sessionsInvalidated: false } });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('left sessions valid across a restore');
  });

  it('refuses a restore that left existing capabilities valid', () => {
    const input = restored();
    const parsed = parseBackupManifest({ ...input, restore: { ...input.restore, capabilitiesInvalidated: false } });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('left capabilities valid across a restore');
  });

  it('refuses a restore with no rollback plan', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      restore: { ...input.restore, rollback: { ...input.restore.rollback, plan: '' } },
    });
    expect(parsed.ok).toBe(false);
    expect(pathsOf(parsed)).toContain('backup.restore.rollback.plan');
  });

  it('refuses a rollback that was never verified', () => {
    const input = restored();
    const parsed = parseBackupManifest({
      ...input,
      restore: { ...input.restore, rollback: { ...input.restore.rollback, verified: false } },
    });
    expect(parsed.ok).toBe(false);
    expect(messagesOf(parsed)).toContain('the rollback was never verified');
  });

  it('refuses a manifest missing the three sections a restore is what produces', () => {
    const parsed = parseBackupManifest(production());
    expect(parsed.ok).toBe(false);
    expect(pathsOf(parsed)).toEqual(
      expect.arrayContaining(['backup.integrity', 'backup.objectives', 'backup.restore']),
    );
  });

  it('reports every problem in one pass rather than the first', () => {
    const parsed = parseBackupManifest({
      ...restored(),
      integrity: { verifiedBeforeRestore: false, algorithm: '', mismatchAborts: false },
      objectives: { rpoMinutes: 60, rtoMinutes: 240, measured: { rpoMinutes: 900, rtoMinutes: 900 } },
      restore: { sessionsInvalidated: false, capabilitiesInvalidated: false, rollback: { plan: '', verified: false } },
    });
    expect(parsed.ok).toBe(false);
    expect(pathsOf(parsed)).toEqual(
      expect.arrayContaining([
        'backup.integrity.verifiedBeforeRestore',
        'backup.integrity.mismatchAborts',
        'backup.integrity.algorithm',
        'backup.objectives.measured.rtoMinutes',
        'backup.restore.sessionsInvalidated',
        'backup.restore.capabilitiesInvalidated',
        'backup.restore.rollback.plan',
        'backup.restore.rollback.verified',
      ]),
    );
  });
});

// What a restore is asked to do: which content classes to put back, independently of one another, and
// that it replaces what is there rather than merging with it — see `apps/app/src/restore-apply.ts`.
describe('what a restore may be asked to do', () => {
  it('accepts one class selected on its own', () => {
    const parsed = parseRestoreSelection({ mode: 'replace', classes: ['mongo'] });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.classes : undefined).toEqual(['mongo']);
  });

  it('accepts every class independently selected in any combination', () => {
    for (const combination of [['mongo'], ['settings'], ['media'], ['mongo', 'media'], [...RESTORE_CLASSES]]) {
      const parsed = parseRestoreSelection({ mode: 'replace', classes: combination });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok ? [...parsed.value.classes].sort() : undefined).toEqual([...combination].sort());
    }
  });

  it('refuses a selection that names nothing to restore', () => {
    const parsed = parseRestoreSelection({ mode: 'replace', classes: [] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.classes');
  });

  it('refuses a class this release does not back up', () => {
    const parsed = parseRestoreSelection({ mode: 'replace', classes: ['mongo', 'themes'] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.classes.1');
  });

  it('refuses the same class selected twice', () => {
    const parsed = parseRestoreSelection({ mode: 'replace', classes: ['mongo', 'mongo'] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.message)).toContain(
      'mongo is selected more than once',
    );
  });

  it('rejects a merge rather than partially applying it', () => {
    const parsed = parseRestoreSelection({ mode: 'merge', classes: ['mongo'] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.mode');
  });

  it('refuses a selection with no mode at all', () => {
    const parsed = parseRestoreSelection({ classes: ['mongo'] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.mode');
  });
});


describe('what an operator may ask an on-demand backup to cover', () => {
  it('defaults absent components to every class', () => {
    const parsed = parseBackupRequest({});
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.components : undefined).toEqual(RESTORE_CLASSES);
  });

  it('accepts a settings-only backup', () => {
    const parsed = parseBackupRequest({ components: ['settings'] });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.components : undefined).toEqual(['settings']);
  });

  it.each([
    { components: [], path: 'backup.components' },
    { components: ['bogus'], path: 'backup.components.0' },
    { components: ['mongo', 'mongo'], path: 'backup.components.1' },
  ])('refuses $components at $path', ({ components, path }) => {
    const parsed = parseBackupRequest({ components });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain(path);
  });
});

describe('what an operator must confirm to restore a backup into production', () => {
  it('accepts a request whose confirm repeats backupId exactly, defaulting components to every class', () => {
    const parsed = parseRestoreRequest({ backupId: 'backup-2026-09-19T02-00-00Z', confirm: 'backup-2026-09-19T02-00-00Z' });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value : undefined).toEqual({
      backupId: 'backup-2026-09-19T02-00-00Z',
      components: RESTORE_CLASSES,
    });
  });

  it('accepts a narrowed component list', () => {
    const parsed = parseRestoreRequest({
      backupId: 'backup-2026-09-19T02-00-00Z',
      confirm: 'backup-2026-09-19T02-00-00Z',
      components: ['mongo'],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.components : undefined).toEqual(['mongo']);
  });

  it('refuses a confirm that does not repeat backupId', () => {
    const parsed = parseRestoreRequest({ backupId: 'backup-2026-09-19T02-00-00Z', confirm: 'backup-2026-09-18T02-00-00Z' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.confirm');
  });

  it('refuses a request with no confirm at all', () => {
    const parsed = parseRestoreRequest({ backupId: 'backup-2026-09-19T02-00-00Z' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain('restore.confirm');
  });

  it.each([
    { components: [], path: 'restore.components' },
    { components: ['bogus'], path: 'restore.components.0' },
    { components: ['mongo', 'mongo'], path: 'restore.components.1' },
  ])('refuses $components at $path', ({ components, path }) => {
    const parsed = parseRestoreRequest({
      backupId: 'backup-2026-09-19T02-00-00Z',
      confirm: 'backup-2026-09-19T02-00-00Z',
      components,
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toContain(path);
  });
});
