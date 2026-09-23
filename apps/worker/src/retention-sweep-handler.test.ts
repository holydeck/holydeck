import { retentionSweepContext } from '@holydeck/app/audit';
import { describe, expect, it, vi } from 'vitest';

import { retentionSweepOn } from './retention-sweep-handler.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { NotificationStore } from '@holydeck/app/notification-store';
import type { Document } from '@holydeck/app/repositories';
import type { LeasedJob } from '@holydeck/contracts/jobs';
import type { RetentionSweepOptions } from './retention-sweep-handler.js';
import type { SchedulerStateStore } from './scheduler-state.js';

const NOW = '2026-09-23T02:00:00.000Z';
const CONTEXT = retentionSweepContext('system', 'test');
const MS_PER_DAY = 86_400_000;

const job = (): LeasedJob => ({
  id: 'job-1',
  kind: 'retention-sweep',
  idempotencyKey: `retention-sweep:${NOW}`,
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-23T02:01:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  payload: {},
});

const auditRow = (n: number, ageDays: number): Document => ({
  _id: `audit:row-${n}`,
  actor: 'system',
  correlationId: 'test',
  at: new Date(Date.parse(NOW) - ageDays * MS_PER_DAY).toISOString(),
  action: 'session.signIn',
  subject: `account-${n}`,
  outcome: 'allowed',
});

const fixture = (rows: Document[] = [], overrides: Partial<RetentionSweepOptions> = {}) => {
  const db = fakeDb();
  db.rows.set('audit_events', rows);
  const markRetentionSweep = vi.fn<SchedulerStateStore['markRetentionSweep']>().mockResolvedValue(undefined);
  const schedulerState: SchedulerStateStore = {
    read: async () => ({}),
    markBackup: async () => undefined,
    markRestoreRehearsal: async () => undefined,
    markRetentionSweep,
  };
  const expireRead = vi.fn<NotificationStore['expireRead']>().mockResolvedValue(3);
  const notificationStore: NotificationStore = {
    listFor: async () => [],
    markRead: async () => false,
    markAllRead: async () => {},
    markDismissed: async () => false,
    expireRead,
    preferencesFor: async (recipient) => ({ recipient, muted: false, channels: [] }),
    setPreferences: async () => {},
    materialize: async () => {},
    watermarkFor: async () => undefined,
    setWatermark: async () => {},
  };
  const run = retentionSweepOn({
    context: CONTEXT,
    db,
    autosaveRetentionDays: 30,
    auditRetentionDays: 400,
    notificationStore,
    notificationReadRetentionDays: 30,
    now: () => NOW,
    schedulerState,
    ...overrides,
  });
  const summary = (): Document | undefined =>
    db.rows.get('audit_events')?.find((row) => row['action'] === 'retention.sweep');
  return { db, run, summary, markRetentionSweep, expireRead };
};

describe('sweeping the audit trail against its own retention window', () => {
  it('expires read notifications at the configured cutoff and audits the actual count', async () => {
    const { run, summary, expireRead } = fixture([], { notificationReadRetentionDays: 7 });
    await run(job(), new AbortController().signal);
    expect(expireRead).toHaveBeenCalledExactlyOnceWith('2026-09-16T02:00:00.000Z');
    expect(summary()?.['subject']).toContain('notifications: 3 expired');
  });

  it('does not record success when notification expiry fails', async () => {
    const { run, summary, expireRead, markRetentionSweep } = fixture();
    expireRead.mockRejectedValue(new Error('notification expiry unavailable'));
    await expect(run(job(), new AbortController().signal)).rejects.toThrow('notification expiry unavailable');
    expect(summary()).toBeUndefined();
    expect(markRetentionSweep).not.toHaveBeenCalled();
  });

  it('grades only rows older than the configured window', async () => {
    const { run, summary } = fixture([auditRow(1, 600), auditRow(2, 501), auditRow(3, 499)], {
      auditRetentionDays: 500,
    });
    await run(job(), new AbortController().signal);
    expect(summary()).toMatchObject({ action: 'retention.sweep', actor: 'system', correlationId: 'test', outcome: 'allowed' });
    expect(summary()?.['subject']).toContain('audit-entry: 2 removable, 0 retained');
  });

  it('still audits a completed sweep when there are no audit rows', async () => {
    const { run, summary } = fixture();
    await run(job(), new AbortController().signal);
    expect(summary()?.['subject']).toContain('audit-entry: 0 removable, 0 retained');
  });

  it('marks completion exactly once at the supplied instant', async () => {
    const { run, markRetentionSweep } = fixture();
    await run(job(), new AbortController().signal);
    expect(markRetentionSweep).toHaveBeenCalledExactlyOnceWith(NOW);
  });

  it('leaves every existing audit row unchanged and only appends its summary', async () => {
    const rows = [auditRow(1, 900), auditRow(2, 800), auditRow(3, 700)];
    const before = structuredClone(rows);
    const { db, run, summary } = fixture(rows);
    await run(job(), new AbortController().signal);
    const after = db.rows.get('audit_events') ?? [];
    expect(after.filter((row) => row['action'] !== 'retention.sweep')).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toEqual(summary());
  });

  it('reports the deferred autosave class in the summary and the operational report', async () => {
    const report = vi.fn<(line: string) => void>();
    const { run, summary } = fixture([], { report });
    await run(job(), new AbortController().signal);
    expect(summary()?.['subject']).toContain('autosave-revision: 0 removable, 0 retained (deferred)');
    expect(report).toHaveBeenCalledWith('retention sweep: autosave-revision sweep deferred — see maintainer TODO');
  });

  it('excludes the exact cutoff and younger rows, while grading the row a full day older', async () => {
    const rows = [auditRow(1, 401), auditRow(2, 400), auditRow(3, 399)];
    const before = structuredClone(rows);
    const { db, run, summary } = fixture(rows);
    await run(job(), new AbortController().signal);
    expect(summary()?.['subject']).toContain('audit-entry: 1 removable, 0 retained');
    expect(db.rows.get('audit_events')?.slice(0, 3)).toEqual(before);
  });

  it('applies the same override to grading as it already does to gathering', async () => {
    const { run, summary } = fixture([auditRow(1, 500), auditRow(2, 401), auditRow(3, 100), auditRow(4, 89)], {
      auditRetentionDays: 90,
    });
    await run(job(), new AbortController().signal);
    // Age 89 is younger than the 90-day cutoff, so it is never gathered at all. All three gathered rows
    // (500, 401, 100) clear that same 90-day window, so grading them against the default 400-day policy
    // instead — as if the override stopped at gathering — would wrongly retain the 100-day-old row.
    expect(summary()?.['subject']).toContain('audit-entry: 3 removable, 0 retained');
  });

  it('continues gathering after a full page without counting its rows twice', async () => {
    const rows = Array.from({ length: 501 }, (_, n) => auditRow(n, 1001 - n));
    const { run, summary } = fixture(rows);
    await run(job(), new AbortController().signal);
    expect(summary()?.['subject']).toContain('audit-entry: 501 removable, 0 retained');
  });

  it('bounds gathering at fifty pages and reports the remaining work', async () => {
    const rows = Array.from({ length: 25_001 }, (_, n) => auditRow(n, 26_000 - n));
    const report = vi.fn<(line: string) => void>();
    const { run, summary } = fixture(rows, { report });
    await run(job(), new AbortController().signal);
    expect(summary()?.['subject']).toContain('audit-entry: 25000 removable, 0 retained');
    expect(report).toHaveBeenCalledWith('retention sweep: audit-entry gathering hit its 50-page cap — more remains for next run');
  });

  it('does not audit or mark completion after losing its lease', async () => {
    const { run, summary, markRetentionSweep } = fixture([auditRow(1, 500)]);
    const controller = new AbortController();
    controller.abort();
    await expect(run(job(), controller.signal)).rejects.toThrow('retention sweep stopped after its lease was lost');
    expect(summary()).toBeUndefined();
    expect(markRetentionSweep).not.toHaveBeenCalled();
  });

  it('does not mark completion when writing the summary fails', async () => {
    const { db, run, summary, markRetentionSweep } = fixture();
    db.failOn = () => new Error('audit write failed');
    await expect(run(job(), new AbortController().signal)).rejects.toThrow('audit write failed');
    expect(summary()).toBeUndefined();
    expect(markRetentionSweep).not.toHaveBeenCalled();
  });
});
