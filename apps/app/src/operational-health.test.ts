import { describe, expect, test } from 'vitest';

import {
  OPERATIONAL_CODES,
  OPERATIONAL_DOMAINS,
  QUEUE_WAIT_WARNING_MINUTES,
  REHEARSAL_INTERVAL_MINUTES,
  UNREADABLE,
  observeOperationalHealth,
  operationalHealthOf,
} from './operational-health.js';
import { LEASE_LOST } from './queue.js';
import { RECOVERY_OBJECTIVES } from './restores.js';

import type {
  OperationalCode,
  OperationalFinding,
  OperationalHealthReport,
  OperationalReadings,
  OperationalSources,
  QueueReading,
  ReadinessReading,
  RecordedRehearsal,
  StorageReading,
} from './operational-health.js';
import type { RecordedBackup } from './backups.js';
import type { JobRecord } from '@holydeck/contracts/jobs';
import type { MediaManifestEntry, MediaProcessingState } from '@holydeck/contracts/media';

const AT = '2026-09-21T09:00:00.000Z';

const before = (minutes: number): string => new Date(Date.parse(AT) - minutes * 60_000).toISOString();
const after = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const job = (over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: 'job-1',
    kind: 'media-ingest',
    idempotencyKey: 'media-ingest:1',
    payload: {},
    state: 'succeeded',
    attempt: 1,
    retryLimit: 5,
    queuedAt: before(2),
    workers: [],
    lastError: undefined,
    leaseExpiresAt: undefined,
    heartbeatAt: undefined,
    ...over,
  }) as JobRecord;

const backupRun = (createdAt: string, classes: readonly string[] = ['mongo', 'settings', 'media']): RecordedBackup => ({
  backupId: `backup-${createdAt}`,
  at: createdAt,
  snapshots: [],
  production: {
    manifest: {
      id: `backup-${createdAt}`,
      createdAt,
      schemaVersion: 19,
      contents: classes.map((name) => ({ class: name, count: 1, bytes: 1024, hash: `restic:${name}` })),
      excludedSecrets: [],
    },
    consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
  },
});

const rehearsalRun = (at: string, measuredRto = 12, objectiveRto = RECOVERY_OBJECTIVES.rtoMinutes): RecordedRehearsal => ({
  at,
  objectives: {
    rpoMinutes: RECOVERY_OBJECTIVES.rpoMinutes,
    rtoMinutes: objectiveRto,
    measured: { rpoMinutes: 30, rtoMinutes: measuredRto },
  },
});

const mediaEntry = (processingState: MediaProcessingState, from = 'original'): MediaManifestEntry => ({
  id: `media-${processingState}`,
  bytes: 4096,
  hash: 'sha256:aaaa',
  type: 'image/png',
  processingState,
  derivatives: processingState === 'ready' ? [{ kind: 'poster', bytes: 512, hash: 'sha256:bbbb', from }] : [],
});

const admitted = (persistence: 'granted' | 'refused' | 'unsupported'): Extract<StorageReading, { kind: 'admitted' }> => ({
  kind: 'admitted',
  estimatedBytes: 400_000_000,
  requiredBytes: 440_000_000,
  availableBytes: 2_000_000_000,
  persistence,
  skippedAssetIds: [],
});

const rehearsed: ReadinessReading = { kind: 'rehearsed', rehearsedSlideIds: ['slide-1', 'slide-2'], blockers: [] };

/** Every domain measured and nothing wrong with any of it: the floor every fixture below varies from. */
const healthy = (): OperationalReadings => ({
  at: AT,
  health: { at: before(0.1), staleAfterMs: 45_000 },
  storage: admitted('granted'),
  queue: { counts: { queued: 0, leased: 1, succeeded: 12, failed: 0 }, jobs: [job({ state: 'succeeded' })] },
  backup: [backupRun(before(60))],
  restore: [rehearsalRun(before(120))],
  media: [mediaEntry('ready')],
  readiness: rehearsed,
});

const readings = (over: Partial<OperationalReadings>): OperationalReadings => ({ ...healthy(), ...over });

const findingsOf = (report: OperationalHealthReport): readonly OperationalFinding[] =>
  report.statuses.flatMap((status) => status.findings);

const codesOf = (report: OperationalHealthReport): readonly OperationalCode[] =>
  findingsOf(report).map((found) => found.code);

const actionFor = (given: OperationalReadings, code: OperationalCode): string =>
  findingsOf(operationalHealthOf(given)).find((found) => found.code === code)?.action ?? '';

/**
 * One reading per code the surface can report. The completeness test below compares this list against
 * `OPERATIONAL_CODES`, so a code added without a reading that produces it fails rather than going
 * unproven — which is what keeps "every status is actionable" a statement about every status.
 */
const FIXTURES: readonly (readonly [OperationalCode, OperationalReadings])[] = [
  ['health.ok', healthy()],
  ['health.workerSilent', readings({ health: { staleAfterMs: 45_000 } })],
  ['health.workerStale', readings({ health: { at: before(5), staleAfterMs: 45_000 } })],
  ['health.clockSkew', readings({ health: { at: after(5), staleAfterMs: 45_000 } })],
  ['health.unreadable', readings({ health: UNREADABLE })],

  ['storage.ok', healthy()],
  ['storage.unreported', readings({ storage: undefined })],
  ['storage.unreadable', readings({ storage: UNREADABLE })],
  ['storage.estimateUnavailable', readings({ storage: { kind: 'blocked', blockers: [{ code: 'storage.estimateUnavailable' }] } })],
  [
    'storage.quotaShortfall',
    readings({
      storage: {
        kind: 'blocked',
        blockers: [
          { code: 'storage.quotaShortfall', requiredBytes: 2_000_000_000, availableBytes: 500_000_000, shortfallBytes: 1_500_000_000 },
        ],
      },
    }),
  ],
  [
    'storage.assetSizeUnknown',
    readings({ storage: { kind: 'blocked', blockers: [{ code: 'asset.sizeUnknown', assetId: 'asset-1' }] } }),
  ],
  ['storage.evictable', readings({ storage: admitted('refused') })],
  ['storage.persistenceUnsupported', readings({ storage: admitted('unsupported') })],

  ['queue.ok', healthy()],
  ['queue.unreadable', readings({ queue: UNREADABLE })],
  [
    'queue.failed',
    readings({ queue: { counts: { queued: 0, leased: 0, succeeded: 4, failed: 3 }, jobs: [job({ state: 'failed' })] } }),
  ],
  [
    'queue.leasesLost',
    readings({
      queue: {
        counts: { queued: 1, leased: 0, succeeded: 4, failed: 0 },
        jobs: [job({ state: 'queued', queuedAt: before(1), lastError: LEASE_LOST })],
      },
    }),
  ],
  [
    'queue.stalled',
    readings({
      queue: { counts: { queued: 2, leased: 0, succeeded: 4, failed: 0 }, jobs: [job({ state: 'queued', queuedAt: before(45) })] },
    }),
  ],
  [
    'queue.attemptsRunningOut',
    readings({
      queue: {
        counts: { queued: 1, leased: 0, succeeded: 4, failed: 0 },
        jobs: [job({ state: 'queued', attempt: 5, retryLimit: 5, queuedAt: before(1) })],
      },
    }),
  ],

  ['backup.ok', healthy()],
  ['backup.unreadable', readings({ backup: UNREADABLE })],
  ['backup.none', readings({ backup: [] })],
  ['backup.overdue', readings({ backup: [backupRun(before(RECOVERY_OBJECTIVES.rpoMinutes + 300))] })],
  ['backup.incomplete', readings({ backup: [backupRun(before(60), ['mongo', 'settings'])] })],

  ['restore.ok', healthy()],
  ['restore.unreadable', readings({ restore: UNREADABLE })],
  ['restore.neverRehearsed', readings({ restore: [] })],
  ['restore.rehearsalOverdue', readings({ restore: [rehearsalRun(before(REHEARSAL_INTERVAL_MINUTES + 60))] })],
  ['restore.recoveryTimeAtRisk', readings({ restore: [rehearsalRun(before(120), 200)] })],
  ['restore.recoveryTimeMissed', readings({ restore: [rehearsalRun(before(120), 300)] })],

  ['media.ok', healthy()],
  ['media.unreadable', readings({ media: UNREADABLE })],
  ['media.failed', readings({ media: [mediaEntry('ready'), mediaEntry('failed')] })],
  ['media.backlog', readings({ media: [mediaEntry('ready'), mediaEntry('pending')] })],

  ['readiness.ok', healthy()],
  ['readiness.unreported', readings({ readiness: undefined })],
  ['readiness.unreadable', readings({ readiness: UNREADABLE })],
  [
    'readiness.cacheIncomplete',
    readings({
      readiness: {
        kind: 'blocked',
        rehearsedSlideIds: [],
        blockers: [{ code: 'cache.incomplete', pendingAssetIds: ['asset-1', 'asset-2'] }],
      },
    }),
  ],
  [
    'readiness.snapshotUnusable',
    readings({ readiness: { kind: 'blocked', rehearsedSlideIds: [], blockers: [{ code: 'snapshot.noDocuments' }] } }),
  ],
  [
    'readiness.environmentDiverged',
    readings({
      readiness: {
        kind: 'blocked',
        rehearsedSlideIds: [],
        blockers: [
          {
            code: 'render.diverged',
            documentId: 'document-1',
            recordedFrameHash: 'sha256:aaaa',
            renderedFrameHash: 'sha256:bbbb',
          },
        ],
      },
    }),
  ],
  [
    'readiness.slidesBlocked',
    readings({
      readiness: {
        kind: 'blocked',
        rehearsedSlideIds: [],
        blockers: [{ code: 'render.blocked', documentId: 'document-1', findings: [] }],
      },
    }),
  ],
];

describe('the shape of the surface', () => {
  test('reports one status for each of the seven domains OPER-01 names', () => {
    const report = operationalHealthOf(healthy());
    expect(report.statuses.map((status) => status.domain)).toEqual([...OPERATIONAL_DOMAINS]);
    expect(report.at).toBe(AT);
  });

  test('calls a deployment with nothing wrong anywhere healthy', () => {
    const report = operationalHealthOf(healthy());
    expect(report.state).toBe('ok');
    expect(report.statuses.every((status) => status.state === 'ok')).toBe(true);
  });
});

// OPER-01's first bar: a status nobody can act on is not a status, it is a colour.
describe('every status is actionable', () => {
  test('every code the surface can report has a reading that produces it', () => {
    expect([...new Set(FIXTURES.map(([code]) => code))].sort()).toEqual([...OPERATIONAL_CODES].sort());
  });

  for (const [code, given] of FIXTURES) {
    test(`${code} states what to do about it`, () => {
      const found = findingsOf(operationalHealthOf(given)).find((candidate) => candidate.code === code);
      expect(found, `no finding carried ${code}`).toBeDefined();
      expect(found?.action.trim()).not.toBe('');
    });
  }

  test('no finding anywhere in any of those readings is left without an action', () => {
    for (const [, given] of FIXTURES) {
      const report = operationalHealthOf(given);
      expect(findingsOf(report).length).toBeGreaterThan(0);
      for (const found of findingsOf(report)) expect(found.action.trim()).not.toBe('');
      for (const status of report.statuses) {
        expect(status.findings.length).toBeGreaterThan(0);
        expect(status.action.trim()).not.toBe('');
      }
      expect(report.action.trim()).not.toBe('');
    }
  });

  test('a domain speaks with the voice of its worst finding, not its first', () => {
    // An overdue rehearsal (degraded) is found before a missed recovery time (failed), so the domain has
    // to be upgraded by the later finding rather than settling for the one it saw first.
    const report = operationalHealthOf(
      readings({ restore: [rehearsalRun(before(REHEARSAL_INTERVAL_MINUTES + 60), 300)] }),
    );
    const restore = report.statuses.find((status) => status.domain === 'restore');
    expect(restore?.findings.map((found) => found.code)).toEqual([
      'restore.rehearsalOverdue',
      'restore.recoveryTimeMissed',
    ]);
    expect(restore?.findings[0]?.state).toBe('degraded');
    expect(restore?.state).toBe('failed');
    expect(restore?.action).toBe(restore?.findings[1]?.action);
    expect(restore?.action).not.toBe(restore?.findings[0]?.action);
  });
});

// OPER-01's second bar, and the standing rule the whole deployment is held to: an operator screen may
// show what is wrong, never where it lives or what it is authenticated with.
describe('no secret and no private infrastructure detail reaches a status', () => {
  const SECRETS = [
    'mongodb://root:hunter2@db.internal:27017',
    '/srv/holydeck/data/worker/heartbeat.json',
    '/srv/holydeck/media/original/psalm-23.mp4',
    '/srv/holydeck/backups',
    '10.4.2.9',
    'worker-01.internal',
    'corpusToken',
    'sk-live-4f2a9c',
  ];

  const leaky = (): OperationalReadings => ({
    at: AT,
    health: { at: before(5), pid: 4242, paths: ['/srv/holydeck/data/worker/heartbeat.json'], staleAfterMs: 45_000 },
    storage: { kind: 'blocked', blockers: [{ code: 'asset.sizeUnknown', assetId: '/srv/holydeck/media/original/psalm-23.mp4' }] },
    queue: {
      counts: { queued: 1, leased: 0, succeeded: 2, failed: 1 },
      jobs: [
        job({
          state: 'failed',
          workers: ['worker-01.internal'],
          payload: { mongoUrl: 'mongodb://root:hunter2@db.internal:27017', corpusToken: 'sk-live-4f2a9c' },
          lastError: 'restic: the repository at /srv/holydeck/backups on 10.4.2.9 is locked',
        }),
        job({ state: 'queued', queuedAt: before(45), lastError: LEASE_LOST }),
      ],
    },
    backup: [
      {
        ...backupRun(before(3000)),
        production: {
          manifest: {
            id: 'backup-1',
            createdAt: before(3000),
            schemaVersion: 19,
            contents: [{ class: 'mongo', count: 1, bytes: 1, hash: 'restic:/srv/holydeck/backups' }],
            excludedSecrets: ['corpusToken', 'sk-live-4f2a9c'],
          },
          consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time on 10.4.2.9' },
        },
      },
    ],
    restore: [rehearsalRun(before(120), 300)],
    media: [mediaEntry('failed', '/srv/holydeck/media/original/psalm-23.mp4'), mediaEntry('pending')],
    readiness: {
      kind: 'blocked',
      rehearsedSlideIds: [],
      blockers: [
        { code: 'cache.incomplete', pendingAssetIds: ['/srv/holydeck/media/original/psalm-23.mp4'] },
        { code: 'document.unreadable', documentId: 'mongodb://root:hunter2@db.internal:27017', reason: 'SyntaxError' },
      ],
    },
  });

  test('the readings this is checked against really do carry every one of those secrets', () => {
    const text = JSON.stringify(leaky());
    for (const secret of SECRETS) expect(text).toContain(secret);
  });

  test('and the report derived from them carries none', () => {
    const text = JSON.stringify(operationalHealthOf(leaky()));
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  test('while still reporting what was actually wrong', () => {
    const report = operationalHealthOf(leaky());
    expect(report.state).toBe('failed');
    expect(codesOf(report)).toEqual(
      expect.arrayContaining([
        'health.workerStale',
        'storage.assetSizeUnknown',
        'queue.failed',
        'backup.overdue',
        'restore.recoveryTimeMissed',
        'media.failed',
        'readiness.cacheIncomplete',
      ]),
    );
  });

  test('because a fact is a measured number and never a borrowed string', () => {
    for (const [, given] of [...FIXTURES, ['leaky', leaky()] as const]) {
      for (const found of findingsOf(operationalHealthOf(given as OperationalReadings))) {
        for (const value of Object.values(found.facts)) expect(typeof value).toBe('number');
      }
    }
  });
});

// OPER-01's third bar: prose keyed to a status enum is a label, not a recommendation.
describe('recommendations are derived from what was measured', () => {
  test('a bigger shortfall asks for more room to be freed', () => {
    const shortfall = (bytes: number): OperationalReadings =>
      readings({
        storage: {
          kind: 'blocked',
          blockers: [
            { code: 'storage.quotaShortfall', requiredBytes: bytes + 100_000_000, availableBytes: 100_000_000, shortfallBytes: bytes },
          ],
        },
      });
    const small = actionFor(shortfall(200_000_000), 'storage.quotaShortfall');
    const large = actionFor(shortfall(3_000_000_000), 'storage.quotaShortfall');
    expect(small).toContain('200 MB');
    expect(large).toContain('3000 MB');
    expect(small).not.toBe(large);
  });

  test('an older backup is asked for more urgently, by its own age', () => {
    const aged = (minutes: number): string =>
      actionFor(readings({ backup: [backupRun(before(minutes))] }), 'backup.overdue');
    const late = aged(RECOVERY_OBJECTIVES.rpoMinutes + 60);
    const later = aged(RECOVERY_OBJECTIVES.rpoMinutes + 6000);
    expect(late).toContain(String(RECOVERY_OBJECTIVES.rpoMinutes + 60));
    expect(later).toContain(String(RECOVERY_OBJECTIVES.rpoMinutes + 6000));
    expect(late).not.toBe(later);
  });

  test('the same media backlog asks for a different thing depending on whether the worker is alive', () => {
    const waiting = { media: [mediaEntry('pending'), mediaEntry('processing')] };
    const alive = actionFor(readings(waiting), 'media.backlog');
    const dead = actionFor(readings({ ...waiting, health: { staleAfterMs: 45_000 } }), 'media.backlog');
    expect(alive).not.toBe(dead);
    expect(dead).toContain('Start the worker');
    expect(alive).not.toContain('Start the worker');
  });

  test('and so does the same waiting queue', () => {
    const stalled = {
      queue: { counts: { queued: 3, leased: 0, succeeded: 1, failed: 0 }, jobs: [job({ state: 'queued', queuedAt: before(45) })] },
    };
    const alive = actionFor(readings(stalled), 'queue.stalled');
    const dead = actionFor(readings({ ...stalled, health: { at: before(30), staleAfterMs: 45_000 } }), 'queue.stalled');
    expect(alive).not.toBe(dead);
    expect(dead).toContain('Start the worker');
    expect(alive).toContain('45');
  });

  test('a healthy status still quotes the numbers that made it healthy', () => {
    const roomy = actionFor(readings({ storage: { ...admitted('granted'), availableBytes: 9_000_000_000 } }), 'storage.ok');
    const tight = actionFor(readings({ storage: { ...admitted('granted'), availableBytes: 900_000_000 } }), 'storage.ok');
    expect(roomy).toContain('9000 MB');
    expect(tight).toContain('900 MB');
    expect(roomy).not.toBe(tight);
  });

  test('the whole surface points at the domains that actually failed', () => {
    const oneDown = operationalHealthOf(readings({ backup: [] }));
    const twoDown = operationalHealthOf(readings({ backup: [], restore: [] }));
    expect(oneDown.action).toContain('backup');
    expect(oneDown.action).not.toContain('restore');
    expect(twoDown.action).toContain('backup');
    expect(twoDown.action).toContain('restore');
    expect(oneDown.action).not.toBe(twoDown.action);
  });

  test('and says so differently when nothing failed but something is merely degraded', () => {
    const degraded = operationalHealthOf(readings({ storage: admitted('refused') }));
    expect(degraded.state).toBe('degraded');
    expect(degraded.action).toContain('storage');
    expect(degraded.action).not.toBe(operationalHealthOf(healthy()).action);
  });

  test('and differently again when a domain could not be read at all', () => {
    const unknown = operationalHealthOf(readings({ queue: UNREADABLE }));
    expect(unknown.state).toBe('unknown');
    expect(unknown.action).toContain('queue');
  });
});

describe('readings the surface cannot make sense of', () => {
  test('a blocked preflight whose blockers mean nothing here is reported as unreadable, never as ready', () => {
    const report = operationalHealthOf(
      readings({ storage: { kind: 'blocked', blockers: [{ code: 'storage.somethingNewer' } as never] } }),
    );
    expect(report.statuses.find((status) => status.domain === 'storage')?.state).toBe('unknown');
    expect(codesOf(report)).toContain('storage.unreadable');
  });

  test('a blocked rehearsal whose blockers mean nothing here is reported the same way', () => {
    const report = operationalHealthOf(
      readings({
        readiness: { kind: 'blocked', rehearsedSlideIds: [], blockers: [{ code: 'render.somethingNewer' } as never] },
      }),
    );
    expect(report.statuses.find((status) => status.domain === 'readiness')?.state).toBe('unknown');
    expect(codesOf(report)).toContain('readiness.unreadable');
  });

  test('a recorded instant that is not an instant leaves that domain unreadable rather than young', () => {
    const report = operationalHealthOf(readings({ backup: [backupRun('the day before yesterday')] }));
    expect(codesOf(report)).toContain('backup.unreadable');
  });

  test('the newest recorded run decides, whatever order the rows arrive in', () => {
    const report = operationalHealthOf(
      readings({ backup: [backupRun(before(5000)), backupRun(before(30)), backupRun(before(9000))] }),
    );
    expect(codesOf(report)).toContain('backup.ok');
  });
});

// `Queue.list` answers newest-first, so the oldest queued job — the whole point of a stall check — is the
// first thing to fall off the page. A surface that reported the visible part of a long queue as a healthy
// queue would fail at exactly the moment it is most needed.
describe('a page of jobs is a sample, and the queue says so', () => {
  const page = (over: Partial<QueueReading>): OperationalReadings =>
    readings({
      queue: { counts: { queued: 120, leased: 0, succeeded: 4, failed: 0 }, jobs: [job({ state: 'queued' })], ...over },
    });

  test('a stall hiding beyond the page is found when the oldest queued job is answered for directly', () => {
    const report = operationalHealthOf(page({ oldestQueuedAt: before(90) }));
    const stalled = findingsOf(report).find((found) => found.code === 'queue.stalled');
    expect(stalled?.facts['waitMinutes']).toBe(90);
    expect(stalled?.action).toContain('the oldest has waited 90 minutes');
    expect(stalled?.facts['sampledCount']).toBeUndefined();
  });

  test('and without that answer the same reading reports a healthy queue, which is why it is asked for', () => {
    expect(codesOf(operationalHealthOf(page({})))).toContain('queue.ok');
  });

  test('but that ok says what it looked at instead of claiming the whole queue is fine', () => {
    const partial = findingsOf(operationalHealthOf(page({}))).find((found) => found.code === 'queue.ok');
    expect(partial?.facts['sampledCount']).toBe(1);
    expect(partial?.action).toContain('the oldest waiting job was not measured');
    expect(partial?.action).not.toContain('none waiting longer than');
  });

  test('while a queue that fits on the page keeps its whole-queue claim', () => {
    const whole = findingsOf(operationalHealthOf(healthy())).find((found) => found.code === 'queue.ok');
    expect(whole?.facts['sampledCount']).toBeUndefined();
    expect(whole?.action).toContain(`none waiting longer than ${QUEUE_WAIT_WARNING_MINUTES} minutes`);
  });

  test('a page-derived stall names the sample it was drawn from', () => {
    const stalled = findingsOf(operationalHealthOf(page({ jobs: [job({ state: 'queued', queuedAt: before(45) })] })))
      .find((found) => found.code === 'queue.stalled');
    expect(stalled?.facts['sampledCount']).toBe(1);
    expect(stalled?.action).toContain('one of the 1 most recent has waited 45 minutes');
  });

  test('and so does a job on its last attempt, which can only ever be a page', () => {
    const last = findingsOf(
      operationalHealthOf(page({ jobs: [job({ state: 'queued', attempt: 5, retryLimit: 5 })] })),
    ).find((found) => found.code === 'queue.attemptsRunningOut');
    expect(last?.facts['sampledCount']).toBe(1);
    expect(last?.action).toContain('of the 1 most recent job(s)');
  });

  test('an oldest-queued answer that is not an instant falls back to the page rather than to silence', () => {
    const report = operationalHealthOf(page({ oldestQueuedAt: 'a while ago' }));
    const ok = findingsOf(report).find((found) => found.code === 'queue.ok');
    expect(ok?.facts['sampledCount']).toBe(1);
    expect(ok?.action).toContain('the oldest waiting job was not measured');
  });
});

describe('observing the six subsystems', () => {
  const sources = (over: Partial<OperationalSources> = {}): OperationalSources => ({
    now: () => AT,
    worker: () => Promise.resolve({ at: before(0.1), staleAfterMs: 45_000 }),
    queue: () => Promise.resolve({ counts: { queued: 0, leased: 0, succeeded: 3, failed: 0 }, jobs: [] }),
    backups: () => Promise.resolve([backupRun(before(60))]),
    rehearsals: () => Promise.resolve([rehearsalRun(before(120))]),
    media: () => Promise.resolve([mediaEntry('ready')]),
    storage: () => Promise.resolve(admitted('granted')),
    readiness: () => Promise.resolve(rehearsed),
    ...over,
  });

  test('reads every one of them and grades the result', async () => {
    const report = await observeOperationalHealth(sources());
    expect(report.at).toBe(AT);
    expect(report.state).toBe('ok');
  });

  test('a source that throws costs that domain and no other', async () => {
    const report = await observeOperationalHealth(
      sources({ queue: () => Promise.reject(new Error('mongodb://root:hunter2@db.internal:27017 is unreachable')) }),
    );
    expect(report.statuses.find((status) => status.domain === 'queue')?.state).toBe('unknown');
    expect(report.statuses.filter((status) => status.state === 'ok')).toHaveLength(OPERATIONAL_DOMAINS.length - 1);
    expect(JSON.stringify(report)).not.toContain('mongodb://');
  });

  test('a browser that has reported nothing is unreported rather than unreadable', async () => {
    const report = await observeOperationalHealth(sources({ storage: undefined, readiness: undefined }));
    expect(codesOf(report)).toContain('storage.unreported');
    expect(codesOf(report)).toContain('readiness.unreported');
  });
});
