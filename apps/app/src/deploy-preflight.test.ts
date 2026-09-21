import { describe, expect, it } from 'vitest';

import {
  backupPreflight,
  configurationPreflight,
  deployPreflight,
  migrationPreflight,
} from './deploy-preflight.js';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { RECOVERY_OBJECTIVES } from './restores.js';

import type { RecordedBackup } from './backups.js';
import type { SchemaMigration, SchemaStatus } from './migrations.js';

const status = (over: Partial<SchemaStatus>): SchemaStatus => ({ recorded: 1, required: 1, pending: [], ...over });

const backup = (over: Partial<RecordedBackup>): RecordedBackup => ({
  backupId: 'backup-1',
  at: '2026-09-20T02:00:00.000Z',
  production: { manifest: { hash: 'sha256:a' }, consistency: { pointInTime: true, method: 'transaction' } } as never,
  snapshots: [],
  ...over,
});

describe('the configuration preflight', () => {
  it('passes when the settings load cleanly', () => {
    expect(configurationPreflight({})).toEqual({ ok: true, problems: [] });
  });

  it('blocks on a settings file or environment this build could not actually start on, naming every problem', () => {
    const result = configurationPreflight({ env: { HOLYDECK_PORT: 'not-a-number' } });
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join('\n')).toMatch(/port/iu);
  });
});

describe('the migration preflight', () => {
  it('passes when the schema is already at the version this build needs', () => {
    expect(migrationPreflight(status({}))).toEqual({ ok: true, problems: [] });
  });

  it('blocks when a migration has not been run yet', () => {
    const result = migrationPreflight(status({ recorded: 0, pending: [1], required: 1 }), MIGRATIONS);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/dist\/migrate\.js/u);
  });

  it('blocks when the database is half migrated', () => {
    const blocked = { version: 1, direction: 'up', attempt: 1, phase: 'failed' } as const;
    const result = migrationPreflight(status({ recorded: 0, pending: [], blocked }));
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/roll/u);
  });

  it('blocks when the database is ahead of what this build knows', () => {
    const result = migrationPreflight(status({ recorded: 2, required: 1, pending: [] }));
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/ahead/u);
  });

  // Failure injection (spec 14.3): a migration this build ships that cannot undo itself has to be caught
  // here, not discovered the first time a rollback is actually needed. The interface requires `down` at
  // compile time, so the gap this proves against is a runtime one — a malformed entry TypeScript itself
  // would refuse, exactly the shape a bug in `MIGRATIONS` could still produce.
  it('blocks when a pending migration has no rollback path', () => {
    const broken = { version: 1, name: 'no way back', up: async () => undefined } as unknown as SchemaMigration;
    const result = migrationPreflight(status({ recorded: 0, pending: [1], required: 1 }), [broken]);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/no rollback/u);
  });

  it('every migration this build actually ships can be rolled back', () => {
    const result = migrationPreflight(status({ recorded: 0, pending: MIGRATIONS.map((m) => m.version), required: SCHEMA_VERSION }));
    expect(result.problems.filter((problem) => /no rollback/u.test(problem))).toEqual([]);
  });
});

describe('the backup preflight', () => {
  const now = new Date('2026-09-20T02:10:00.000Z');

  it('passes when the last recorded backup is within the recovery point objective', () => {
    expect(backupPreflight([backup({})], now)).toEqual({ ok: true, problems: [] });
  });

  it('blocks when no backup has ever been recorded', () => {
    const result = backupPreflight([], now);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/no backup/u);
  });

  it('blocks when the last recorded backup is older than the recovery point objective', () => {
    const stale = new Date(now.getTime() + (RECOVERY_OBJECTIVES.rpoMinutes + 1) * 60_000);
    const result = backupPreflight([backup({})], stale);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(new RegExp(`${RECOVERY_OBJECTIVES.rpoMinutes}-minute`, 'u'));
  });

  it('reads the newest backup first, whatever order the list arrived in', () => {
    const recent = backup({ at: now.toISOString() });
    const old = backup({ at: '2020-01-01T00:00:00.000Z' });
    expect(backupPreflight([recent, old], now)).toEqual({ ok: true, problems: [] });
  });
});

describe('the combined deploy preflight', () => {
  const now = new Date('2026-09-20T02:10:00.000Z');

  it('passes only when every check passes', () => {
    const report = deployPreflight({
      configuration: {},
      schema: status({}),
      backups: [backup({ at: now.toISOString() })],
      now,
    });
    expect(report.ok).toBe(true);
  });

  it('blocks when any one check fails, and says which', () => {
    const report = deployPreflight({
      configuration: {},
      schema: status({}),
      backups: [],
      now,
    });
    expect(report.ok).toBe(false);
    expect(report.configuration.ok).toBe(true);
    expect(report.migration.ok).toBe(true);
    expect(report.backup.ok).toBe(false);
  });
});
