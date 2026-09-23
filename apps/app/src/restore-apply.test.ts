import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CONSISTENCY_METHOD, EXCLUDED_SECRETS, MONGO_CONTENTS, archiveEntryOf } from './backups.js';
import { requestContext } from './context.js';
import { RECORDS, permissionsFor } from './records.js';
import { RestoreApplyError, applyRestore, fileRestoreTarget } from './restore-apply.js';
import { RESTORE_RECORD, RestoreError, restoreContext } from './restores.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BackupContent, BackupProduction, RestoreClass, RestoreSelection } from '@holydeck/contracts/backups';
import type { Document } from './repositories.js';
import type { MongoRestoreTarget, RestoreApplyOptions, RestoreApplyTargets, RestoreFileTarget } from './restore-apply.js';
import type { RestoreCapabilities, RestoreCollection, RestoreDb, RestoreSessions } from './restores.js';

const NOW = '2026-09-21T03:00:00.000Z';
const CONTEXT = restoreContext('operator', 'restore-apply-1');
const BACKUP_ID = 'backup-2026-09-21T03-00-00Z';

const RESTIC_MONGO: BackupContent = { class: 'mongo', count: 1, bytes: 4096, hash: 'restic:cc33dd' };
const RESTIC_SETTINGS: BackupContent = { class: 'settings', count: 1, bytes: 512, hash: 'restic:9f2c1b' };
const RESTIC_MEDIA: BackupContent = { class: 'media', count: 1, bytes: 2048, hash: 'restic:aa11bb' };

/** The classes worth seeding with something; every other class is archived empty, which is still a class. */
const SEEDED: Readonly<Record<string, readonly Document[]>> = {
  services: [{ _id: 'service:1', title: 'Sunday morning' }],
  'content-revisions': [{ _id: 'revision:1', body: 'a verse' }],
  'prepared-snapshots': [],
  'run-events': [{ _id: 'event:1' }],
};

/** Every Mongo-held class an archive carries, taken from the census so a new class is covered by adding it. */
const ARCHIVED: Readonly<Record<string, readonly Document[]>> = Object.fromEntries(
  MONGO_CONTENTS.map((content) => [content.class, SEEDED[content.class] ?? []]),
);

/** Writes the Mongo dump exactly as a backup run would have, so `verifyMongoArchive` can read it back. */
const archiveIn = async (dir: string): Promise<readonly BackupContent[]> => {
  await mkdir(dir, { recursive: true });
  const contents: BackupContent[] = [];
  for (const [className, documents] of Object.entries(ARCHIVED)) {
    const { content, text } = archiveEntryOf(className, documents);
    await writeFile(join(dir, `${className}.json`), text, 'utf8');
    contents.push(content);
  }
  return contents;
};

/** A manifest inventorying exactly the restore classes named, plus whatever Mongo classes were archived. */
const productionOf = (
  mongoContents: readonly BackupContent[],
  inventoried: readonly RestoreClass[] = ['mongo', 'settings', 'media'],
): BackupProduction => ({
  manifest: {
    id: BACKUP_ID,
    createdAt: NOW,
    schemaVersion: 19,
    contents: [
      ...mongoContents,
      ...(inventoried.includes('mongo') ? [RESTIC_MONGO] : []),
      ...(inventoried.includes('settings') ? [RESTIC_SETTINGS] : []),
      ...(inventoried.includes('media') ? [RESTIC_MEDIA] : []),
    ],
    excludedSecrets: EXCLUDED_SECRETS,
  },
  consistency: { pointInTime: true, method: CONSISTENCY_METHOD },
});

const selectionOf = (classes: readonly RestoreClass[]): RestoreSelection => ({ mode: 'replace', classes });

interface FakeTarget extends RestoreDb {
  readonly rows: Map<string, Document[]>;
}

const fakeTarget = (log: string[] = []): FakeTarget => {
  const rows = new Map<string, Document[]>();
  return {
    rows,
    collection(name: string): RestoreCollection {
      const held = (): Document[] => {
        const stored = rows.get(name) ?? [];
        rows.set(name, stored);
        return stored;
      };
      return {
        find: () => ({ toArray: async () => held().map((row) => ({ ...row })) }),
        async deleteMany() {
          const stored = held();
          const deletedCount = stored.length;
          stored.length = 0;
          log.push(`clear ${name}`);
          return { deletedCount };
        },
        async insertMany(documents: readonly Document[]) {
          held().push(...documents.map((row) => ({ ...row })));
          log.push(`write ${name}`);
          return { insertedCount: documents.length };
        },
      };
    },
  };
};

const fakeSessions = (log: string[] = []): RestoreSessions => ({
  async revokeEvery() {
    log.push('end every session');
    return 4;
  },
});

const fakeCapabilities = (log: string[] = []): RestoreCapabilities => ({
  async revokeEvery() {
    log.push('revoke every capability');
    return 6;
  },
});

const fakeCompatibility = (log: string[] = []): RestoreApplyOptions['compatibility'] => ({
  async record() {
    log.push('record restore compatibility');
  },
});

/** A passing rehearsal row, shaped the way `rehearseRestore` itself writes one — see `restore-routes.test.ts`'s
 *  own `rehearsal` helper, which this mirrors, since both exercise the same `hasPassingRehearsal` query. */
const rehearsalOf = (backupId: string, at: string): Document => ({
  _id: `restore:${backupId}:${at}`,
  actor: 'system',
  correlationId: 'restore-apply-1',
  restoreId: `restore-${at}`,
  backupId,
  at,
  manifest: {},
  consistency: {},
  integrity: {},
  objectives: {},
  restore: {},
});

/** A `fakeDb()` seeded with a rehearsal `applyRestore`'s own precondition check finds passing, by default for
 *  the backup every test in this file restores. `at` lets a test move that rehearsal outside the 24 h window
 *  it would otherwise satisfy. */
const dbWithRehearsal = (backupId: string = BACKUP_ID, at: string = NOW): ReturnType<typeof fakeDb> => {
  const db = fakeDb();
  db.rows.set(RESTORE_RECORD, [rehearsalOf(backupId, at)]);
  return db;
};

const refusal = async (run: () => Promise<unknown>): Promise<RestoreApplyError | RestoreError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof RestoreApplyError || error instanceof RestoreError) return error;
    throw error;
  }
  throw new Error('the call was expected to be refused');
};

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holydeck-restore-apply-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Rig {
  readonly log: string[];
  readonly mongoTarget: FakeTarget;
  readonly targets: RestoreApplyTargets;
  readonly settingsLivePath: string;
  readonly mediaLivePath: string;
}

/** What "already restored to disk" looks like for settings and media: real files, staged the way a
 * worker's Restic restore would have, so `fileRestoreTarget` is proved against real file state rather
 * than a mock standing in for one. */
const rigFor = async (root: string, log: string[] = []): Promise<Rig> => {
  const mongoTarget = fakeTarget(log);
  const settingsRestoredPath = join(root, 'restored-settings.yaml');
  const settingsLivePath = join(root, 'live-settings.yaml');
  await writeFile(settingsRestoredPath, 'port: 4100\n', 'utf8');
  const mediaRestoredPath = join(root, 'restored-media');
  const mediaLivePath = join(root, 'live-media');
  await mkdir(mediaRestoredPath, { recursive: true });
  await writeFile(join(mediaRestoredPath, 'hymn.mp3'), 'restored media bytes', 'utf8');

  const targets: RestoreApplyTargets = {
    mongo: { restoredRoot: root, target: mongoTarget } satisfies MongoRestoreTarget,
    settings: fileRestoreTarget({ restoredPath: settingsRestoredPath, livePath: settingsLivePath }),
    media: fileRestoreTarget({ restoredPath: mediaRestoredPath, livePath: mediaLivePath }),
  };
  return { log, mongoTarget, targets, settingsLivePath, mediaLivePath };
};

const ALL_CLASSES: readonly RestoreClass[] = ['mongo', 'settings', 'media'];

const nonEmptySubsets = (items: readonly RestoreClass[]): RestoreClass[][] => {
  const subsets: RestoreClass[][] = [];
  for (let mask = 1; mask < 1 << items.length; mask++) {
    subsets.push(items.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
};

describe('selecting which classes a restore replaces', () => {
  test.each(nonEmptySubsets(ALL_CLASSES))('replaces exactly %s, and touches nothing else', async (...classes) => {
    const production = productionOf(await archiveIn(root));
    const { log, mongoTarget, targets, settingsLivePath, mediaLivePath } = await rigFor(root);
    const applied = await applyRestore(dbWithRehearsal(), CONTEXT, production, {
      selection: selectionOf(classes),
      targets,
      sessions: fakeSessions(log),
      capabilities: fakeCapabilities(log),
      compatibility: fakeCompatibility(log),
      now: () => NOW,
    });

    expect(applied.classes).toEqual(classes);
    expect(mongoTarget.rows.get('services')).toEqual(classes.includes('mongo') ? ARCHIVED.services : undefined);

    const settingsReplaced = await readFile(settingsLivePath, 'utf8').then(
      () => true,
      () => false,
    );
    expect(settingsReplaced).toBe(classes.includes('settings'));
    if (classes.includes('settings')) expect(await readFile(settingsLivePath, 'utf8')).toBe('port: 4100\n');

    const mediaReplaced = await readFile(join(mediaLivePath, 'hymn.mp3'), 'utf8').then(
      () => true,
      () => false,
    );
    expect(mediaReplaced).toBe(classes.includes('media'));

    expect(log.includes('end every session')).toBe(classes.includes('mongo'));
    expect(log.includes('revoke every capability')).toBe(classes.includes('mongo'));
    expect(log.includes('record restore compatibility')).toBe(classes.includes('mongo'));
    expect(applied.sessionsEnded).toBe(classes.includes('mongo') ? 4 : undefined);
    expect(applied.capabilitiesRevoked).toBe(classes.includes('mongo') ? 6 : undefined);
  });
});

describe('what a production restore refuses before writing anything', () => {
  test('refuses a class the manifest never inventoried, before any target is touched', async () => {
    const production = productionOf(await archiveIn(root), ['mongo', 'settings']);
    const { log, targets } = await rigFor(root);
    const error = await refusal(() =>
      applyRestore(dbWithRehearsal(), CONTEXT, production, {
        selection: selectionOf(['settings', 'media']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('archive');
    expect(error.message).toContain('media');
    expect(log).toEqual([]);
  });

  test('refuses a selected class with no target wired to receive it, before any target is touched', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const withoutSettings: RestoreApplyTargets = { mongo: targets.mongo, media: targets.media };
    const error = await refusal(() =>
      applyRestore(dbWithRehearsal(), CONTEXT, production, {
        selection: selectionOf(['mongo', 'settings']),
        targets: withoutSettings,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('target');
    expect(error.message).toContain('settings');
    expect(log).toEqual([]);
  });

  test('refuses a merge attempt outright, rather than applying part of it', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, mongoTarget, targets } = await rigFor(root);
    const merge = { mode: 'merge', classes: ['mongo'] } as unknown as RestoreSelection;
    const error = await refusal(() =>
      applyRestore(fakeDb(), CONTEXT, production, { selection: merge, targets, sessions: fakeSessions(log), capabilities: fakeCapabilities(log), compatibility: fakeCompatibility(log), now: () => NOW }),
    );
    expect(error.kind).toBe('mode');
    expect(log).toEqual([]);
    expect(mongoTarget.rows.size).toBe(0);
  });

  test('refuses a backup with no rehearsal on file at all', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const error = await refusal(() =>
      applyRestore(fakeDb(), CONTEXT, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('rehearsal');
    expect(log).toEqual([]);
  });

  test('re-checks the rehearsal itself rather than trusting the route checked it: a rehearsal that has since aged out of the 24 h window is refused here too', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const stale = dbWithRehearsal(BACKUP_ID, '2026-09-19T03:00:00.000Z');
    const error = await refusal(() =>
      applyRestore(stale, CONTEXT, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('rehearsal');
    expect(log).toEqual([]);
  });

  test('refuses an archive whose restored Mongo bytes do not match the manifest, before any target is touched', async () => {
    const production = productionOf(await archiveIn(root));
    await writeFile(join(root, 'services.json'), '[]', 'utf8');
    const { log, targets } = await rigFor(root);
    const error = await refusal(() =>
      applyRestore(dbWithRehearsal(), CONTEXT, production, {
        selection: selectionOf(['mongo']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('integrity');
    expect(log).toEqual([]);
  });

  test('refuses an actor who may not apply one', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const reader = requestContext({
      actor: 'operator',
      permissions: [permissionsFor(RESTORE_RECORD).read],
      correlationId: 'restore-apply-1',
    });
    const error = await refusal(() =>
      applyRestore(fakeDb(), reader, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('permission');
  });

  test('refuses a context that is not one', async () => {
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const error = await refusal(() =>
      applyRestore(fakeDb(), { actor: '' }, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(error.kind).toBe('context');
  });
});

describe('what a production restore leaves behind', () => {
  test('audits a completed restore with the classes it replaced', async () => {
    const db = dbWithRehearsal();
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    await applyRestore(db, CONTEXT, production, {
      selection: selectionOf(['mongo', 'settings']),
      targets,
      sessions: fakeSessions(log),
      capabilities: fakeCapabilities(log),
      compatibility: fakeCompatibility(log),
      now: () => NOW,
    });
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'allowed' });
    expect(String(audited[0]?.['detail'])).toContain('mongo');
    expect(String(audited[0]?.['detail'])).toContain('settings');
    expect(String(audited[0]?.['detail'])).toContain('capabilities revoked');
  });

  test('audits a refusal too, whether this module raised it or the archive verifier did', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const merge = { mode: 'merge', classes: ['mongo'] } as unknown as RestoreSelection;
    await refusal(() =>
      applyRestore(db, CONTEXT, production, { selection: merge, targets, sessions: fakeSessions(log), capabilities: fakeCapabilities(log), compatibility: fakeCompatibility(log), now: () => NOW }),
    );
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'refused' });
  });

  test('audits a refusal from a well-formed but under-permissioned actor', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    const reader = requestContext({
      actor: 'operator',
      permissions: [permissionsFor(RESTORE_RECORD).read],
      correlationId: 'restore-apply-1',
    });
    await refusal(() =>
      applyRestore(db, reader, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'refused', actor: 'operator' });
  });

  test('writes no audit row for a context too malformed to name an actor', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root));
    const { log, targets } = await rigFor(root);
    await refusal(() =>
      applyRestore(db, { actor: '' }, production, {
        selection: selectionOf(['settings']),
        targets,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    );
    expect(db.rows.get(RECORDS.auditEvents.collection) ?? []).toEqual([]);
  });

  test('audits a restore that fails after mongo already replaced, naming what got through', async () => {
    const db = dbWithRehearsal();
    const production = productionOf(await archiveIn(root));
    const { log, mongoTarget, targets } = await rigFor(root);
    const failingSettings: RestoreFileTarget = {
      async replace() {
        throw new Error('disk is full');
      },
    };

    await expect(
      applyRestore(db, CONTEXT, production, {
        selection: selectionOf(['mongo', 'settings']),
        targets: { ...targets, settings: failingSettings },
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        compatibility: fakeCompatibility(log),
        now: () => NOW,
      }),
    ).rejects.toThrow('disk is full');

    expect(mongoTarget.rows.get('services')).toEqual(ARCHIVED.services);
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'refused' });
    expect(String(audited[0]?.['detail'])).toContain('mongo');
    expect(String(audited[0]?.['detail'])).toContain('disk is full');
  });
});
