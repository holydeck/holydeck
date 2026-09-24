import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  CATEGORY_OF,
  auditContext,
  auditOn,
  auditReadContext,
  integrationCallAudit,
  retentionSweepContext,
} from './audit.js';
import { ContextError, requestContext } from './context.js';
import { RepositoryError } from './repositories.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AuditEntry } from './audit.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const AT = '2026-09-13T09:30:00.000Z';
const CORRELATION = 'req-0f9c2a41';

const trailOn = (db: FakeDb, ids: string[] = ['a1', 'a2']) =>
  auditOn(db, { now: () => AT, newId: () => ids.shift() ?? 'spent' });

const entries = (db: FakeDb) => db.rows.get('audit_events') ?? [];

describe('what the trail records', () => {
  it('names who acted, on what, how it turned out and when, and nothing else', async () => {
    const db = fakeDb();
    const context = auditContext('account:7f3a', CORRELATION);
    await trailOn(db).record(context, { action: 'instance.claim', subject: 'account:7f3a', outcome: 'allowed' });
    expect(entries(db)).toEqual([
      {
        _id: 'audit:a1',
        actor: 'account:7f3a',
        correlationId: CORRELATION,
        at: AT,
        action: 'instance.claim',
        category: 'authentication',
        subject: 'account:7f3a',
        outcome: 'allowed',
      },
    ]);
  });

  it('carries a detail only when there is one, rather than a field holding nothing', async () => {
    const db = fakeDb();
    const trail = trailOn(db);
    const context = auditContext('system', CORRELATION);
    await trail.record(context, { action: 'instance.claim', subject: 'lucia', outcome: 'refused' });
    await trail.record(context, {
      action: 'instance.claim',
      subject: 'lucia',
      outcome: 'refused',
      detail: 'the instance has a founder already',
    });
    const [plain, detailed] = entries(db);
    expect(plain).not.toHaveProperty('detail');
    expect(detailed).toMatchObject({ detail: 'the instance has a founder already' });
  });

  it('carries what an integration call cost only when there is a figure, same as detail', async () => {
    const db = fakeDb();
    const trail = trailOn(db);
    const context = auditContext('system', CORRELATION);
    await trail.record(context, { action: 'integration.call', subject: 'resolver', outcome: 'allowed' });
    await trail.record(context, {
      action: 'integration.call',
      subject: 'resolver',
      outcome: 'allowed',
      requestTokens: 512,
      responseTokens: 64,
    });
    const [plain, costed] = entries(db);
    expect(plain).not.toHaveProperty('requestTokens');
    expect(plain).not.toHaveProperty('responseTokens');
    expect(costed).toMatchObject({ requestTokens: 512, responseTokens: 64 });
  });

  it('gives every entry an identifier of its own, so one never overwrites another', async () => {
    const db = fakeDb();
    const trail = auditOn(db, { now: () => AT });
    const context = auditContext('system', CORRELATION);
    const first = await trail.record(context, { action: 'instance.claim', subject: 'a', outcome: 'refused' });
    const second = await trail.record(context, { action: 'instance.claim', subject: 'b', outcome: 'refused' });
    expect(first).not.toEqual(second);
    expect(entries(db)).toHaveLength(2);
  });
});

describe('what the trail refuses', () => {
  it('refuses an action it does not declare, because a trail nobody can enumerate is not one', async () => {
    const db = fakeDb();
    const record = trailOn(db).record(auditContext('system', CORRELATION), {
      action: 'instance.undeclared' as (typeof AUDIT_ACTIONS)[number],
      subject: 'a',
      outcome: 'allowed',
    });
    await expect(record).rejects.toThrow(RepositoryError);
    await expect(record).rejects.toThrow(/instance.undeclared/u);
    expect(entries(db)).toHaveLength(0);
  });

  it('refuses a caller who may not append, and writes nothing while refusing', async () => {
    const db = fakeDb();
    const reader = requestContext({ actor: 'system', permissions: ['auditEvents.read'], correlationId: CORRELATION });
    await expect(
      trailOn(db).record(reader, { action: 'instance.claim', subject: 'a', outcome: 'allowed' }),
    ).rejects.toThrow(RepositoryError);
    expect(entries(db)).toHaveLength(0);
  });

  it('refuses a context that is not one, before it has an actor to record', async () => {
    const db = fakeDb();
    await expect(
      trailOn(db).record({ actor: 'system' }, { action: 'instance.claim', subject: 'a', outcome: 'allowed' }),
    ).rejects.toThrow(RepositoryError);
    expect(entries(db)).toHaveLength(0);
  });
});

describe('the context the trail is written under', () => {
  it('grants a retention sweep exactly reading and appending the trail, and nothing else', () => {
    expect(retentionSweepContext('system', CORRELATION)).toMatchObject({
      actor: 'system',
      permissions: ['auditEvents.read', 'auditEvents.append'],
      correlationId: CORRELATION,
    });
  });

  it('grants appending and nothing else, so the trail cannot be read back through it', () => {
    expect(auditContext('system', CORRELATION)).toMatchObject({
      actor: 'system',
      permissions: ['auditEvents.append'],
      correlationId: CORRELATION,
    });
  });

  it('refuses an actor or a correlation identifier no log could be followed through', () => {
    expect(() => auditContext('system', 'no')).toThrow(ContextError);
    expect(() => auditContext('', CORRELATION)).toThrow(ContextError);
  });

  it('declares the actions this release records, and only those', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'instance.claim',
      'session.signIn',
      'session.lock',
      'totp.enroll',
      'totp.verify',
      'totp.use',
      'totp.regenerate',
      'totp.revoke',
      'passkey.register',
      'passkey.name',
      'passkey.use',
      'passkey.revoke',
      'account.control',
      'account.create',
      'account.disable',
      'account.restore',
      'account.role',
      'authorization.refuse',
      'session.slot.add',
      'session.slot.switch',
      'capability.guest.issue',
      'capability.output.issue',
      'capability.revoke',
      'live.guest.exchange',
      'live.output.exchange',
      'settings.update',
      'content.change',
      'pptx.import',
      'pptx.commit',
      'serviceTemplate.version',
      'serviceTemplate.archive',
      'serviceTemplate.unarchive',
      'serviceTemplate.fromService',
      'service.create',
      'service.duplicate',
      'service.schedule',
      'service.archive',
      'service.edit',
      'service.transition',
      'service.output',
      'service.item.add',
      'service.item.body',
      'service.item.remove',
      'service.item.enable',
      'service.item.disable',
      'service.item.duplicate',
      'service.item.reorder',
      'service.item.revise',
      'run.start',
      'run.end',
      'run.theme',
      'run.addition',
      'run.recap.export',
      'readiness.override',
      'backup.run',
      'backup.request',
      'restore.run',
      'content.conflict.resolve',
      'content.revision.restore',
      'integration.call',
      'integration.enable',
      'integration.disable',
      'restore.apply.request',
      'restore.apply.complete',
      'restore.apply.fail',
      'retention.sweep',
      'job.requeue',
      'notification.read',
      'notification.dismiss',
      'notification.preferences',
      'media.storageMigration.request',
      'media.storageMigration.complete',
      'media.storageMigration.fail',
      'media.storageMigration.cleanup',
      'media.cleanup',
    ]);
  });
});

describe('the category taxonomy', () => {
  it('declares exactly the eight categories ADMN-03 and ADMN-04 name', () => {
    expect(AUDIT_CATEGORIES).toEqual([
      'authentication',
      'authorization',
      'settings',
      'content',
      'presentation',
      'backup',
      'restore',
      'integration',
    ]);
  });

  it('categorizes every declared action, and no action outside the declared list', () => {
    expect(Object.keys(CATEGORY_OF).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('gives every category at least one member action', () => {
    for (const category of AUDIT_CATEGORIES) {
      const members = AUDIT_ACTIONS.filter((action) => CATEGORY_OF[action] === category);
      expect(members.length, `category ${category} has no member action`).toBeGreaterThan(0);
    }
  });

  // `content` drives two things neither of these five actions should: `apps/worker/src/main.ts`'s
  // `CHANGE_CATEGORIES` treats it as "the deployment changed, back it up early", and
  // `notification-routes.ts`'s `OPEN_CATEGORIES` hands it to every signed-in account regardless of role.
  // A daily sweep, a purge an admin already asked for, and a member reading their own inbox are none of
  // those things — none is a content edit a backup would be racing to protect, and the last three are not
  // something a different member should be notified about at all. `integration` is where this trail
  // already keeps the operational actions of the same shape: `job.requeue` and every `media.storageMigration.*`.
  it('keeps retention, notification housekeeping and media cleanup out of content', () => {
    const notContent = ['retention.sweep', 'notification.read', 'notification.dismiss', 'notification.preferences', 'media.cleanup'] as const;
    for (const action of notContent) {
      expect(CATEGORY_OF[action], action).toBe('integration');
    }
  });
});

describe('history recorded before categories were stored', () => {
  const legacy = (db: FakeDb, id: string, action: string, at = AT) =>
    db.collection('audit_events').insertOne({
      _id: `audit:${id}`, actor: 'account:1', correlationId: CORRELATION, at, action, subject: 's', outcome: 'allowed',
    });
  const reader = auditReadContext('account:1', CORRELATION);

  it('reads a row with no stored category under the category its action belongs to', async () => {
    const db = fakeDb();
    await legacy(db, 'old', 'instance.claim');
    const { entries: listed } = await trailOn(db).list(reader, { limit: 10 });
    expect(listed).toEqual([expect.objectContaining({ id: 'old', category: 'authentication' })]);
  });

  it('finds that row under its category filter, and not under another', async () => {
    const db = fakeDb();
    await legacy(db, 'old', 'instance.claim');
    await legacy(db, 'other', 'settings.update');
    const trail = trailOn(db);
    expect((await trail.list(reader, { category: 'authentication', limit: 10 })).entries.map((entry) => entry.id)).toEqual(['old']);
    expect((await trail.list(reader, { category: 'backup', limit: 10 })).entries).toEqual([]);
  });
});

describe('the actions reserved for a surface not yet built', () => {
  it('accepts each one, so the surface that calls it for the first time finds the trail already open', async () => {
    const db = fakeDb();
    const trail = trailOn(db, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    const context = auditContext('system', CORRELATION);
    const reserved = ['content.change', 'backup.run', 'restore.run', 'content.conflict.resolve', 'integration.disable'] as const;
    for (const action of reserved) {
      await expect(trail.record(context, { action, subject: 'reserved', outcome: 'allowed' })).resolves.toBeTruthy();
    }
    expect(entries(db).map((entry) => entry['action'])).toEqual(reserved);
  });
});

describe('what an entry could never be made to carry', () => {
  it('has no field sized or named to hold a prompt, a raw request/response body, or headers', () => {
    expect(Object.keys(CATEGORY_OF).length).toBeGreaterThan(0); // keeps this suite from being a no-op if the block below is ever removed
    // Excess-property checking on an object literal is TypeScript's own proof that AuditEntry's key set is
    // closed to exactly action | subject | outcome | detail | requestTokens | responseTokens.
    // @ts-expect-error -- prompt is not a field AuditEntry declares, and it never should be
    const withPrompt: AuditEntry = { action: 'settings.update', subject: 'x', outcome: 'allowed', prompt: 'never' };
    // @ts-expect-error -- headers is not a field AuditEntry declares, and it never should be
    const withHeaders: AuditEntry = { action: 'settings.update', subject: 'x', outcome: 'allowed', headers: {} };
    // @ts-expect-error -- body is not a field AuditEntry declares, and it never should be
    const withBody: AuditEntry = { action: 'settings.update', subject: 'x', outcome: 'allowed', body: 'raw' };
    expect([withPrompt, withHeaders, withBody]).toHaveLength(3);
  });
});

describe('what the trail keeps of an address or a credential it is handed anyway', () => {
  const LEAKY = 'from 203.0.113.57 and 2001:db8:85a3:8d3:1319:8a2e:370:7348 via mongodb://holydeck:hunter2@db:27017/holydeck at 09:30:00';
  const KEPT = 'from 203.0.113.0/24 and 2001:db8:85a3::/48 via mongodb://holydeck:[redacted]@db:27017/holydeck at 09:30:00';

  it('narrows an address to its /24 (or /48) and drops a URL password before anything is written', async () => {
    const db = fakeDb();
    await trailOn(db).record(auditContext('system', CORRELATION), {
      action: 'session.signIn',
      subject: 'client 198.51.100.23',
      outcome: 'refused',
      detail: LEAKY,
    });
    expect(entries(db)[0]).toMatchObject({ subject: 'client 198.51.100.0/24', detail: KEPT });
    expect(JSON.stringify(entries(db))).not.toContain('hunter2');
  });

  it('narrows the same way when reading back a row written before the trail did', async () => {
    const db = fakeDb();
    await db.collection('audit_events').insertOne({
      _id: 'audit:old', actor: 'system', correlationId: CORRELATION, at: AT, action: 'session.signIn',
      subject: 'client 198.51.100.23', outcome: 'refused', detail: LEAKY,
    });
    const { entries: listed } = await trailOn(db).list(auditReadContext('account:1', CORRELATION), { limit: 10 });
    expect(listed[0]).toMatchObject({ subject: 'client 198.51.100.0/24', detail: KEPT });
  });
});

describe('integrationCallAudit', () => {
  it('records an integration.call entry with token/duration fields from the call info', async () => {
    const db = fakeDb();
    const record = integrationCallAudit(trailOn(db), 'account:1', CORRELATION);
    await record({
      action: 'integration.call',
      subject: 'sermon-ai',
      outcome: 'allowed',
      detail: 'generate-sermon',
      requestTokens: 120,
      responseTokens: 340,
      durationMs: 890,
    });
    const [stored] = entries(db);
    expect(stored).toMatchObject({ requestTokens: 120, responseTokens: 340, durationMs: 890 });
  });
});
