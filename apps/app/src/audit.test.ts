import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, AUDIT_CATEGORIES, CATEGORY_OF, auditContext, auditOn } from './audit.js';
import { ContextError, requestContext } from './context.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
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
      'settings.update',
      'content.change',
      'presentation.run',
      'backup.run',
      'restore.run',
      'integration.call',
      'integration.disable',
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

  it('gives every category at least one member action — a category producing none fails this test', () => {
    for (const category of AUDIT_CATEGORIES) {
      const members = AUDIT_ACTIONS.filter((action) => CATEGORY_OF[action] === category);
      expect(members.length, `category ${category} has no member action`).toBeGreaterThan(0);
    }
  });
});

describe('the actions reserved for a surface not yet built', () => {
  it('accepts each one, so the surface that calls it for the first time finds the trail already open', async () => {
    const db = fakeDb();
    const trail = trailOn(db, ['r1', 'r2', 'r3', 'r4', 'r5']);
    const context = auditContext('system', CORRELATION);
    const reserved = ['content.change', 'presentation.run', 'backup.run', 'restore.run', 'integration.disable'] as const;
    for (const action of reserved) {
      await expect(trail.record(context, { action, subject: 'reserved', outcome: 'allowed' })).resolves.toBeTruthy();
    }
    expect(entries(db).map((entry) => entry['action'])).toEqual(reserved);
  });
});

describe('an outbound integration call', () => {
  it('persists subject, detail, outcome, and the three integration-call fields, and reads back correctly', async () => {
    const db = fakeDb();
    const trail = trailOn(db);
    const context = auditContext('system', CORRELATION);
    await trail.record(context, {
      action: 'integration.call',
      subject: 'anthropic claude-3-haiku',
      detail: 'resolving a book name for content import',
      outcome: 'allowed',
      requestTokens: 42,
      responseTokens: 17,
      durationMs: 812,
    });
    const reader = requestContext({ actor: 'system', permissions: ['auditEvents.read'], correlationId: CORRELATION });
    const read = await repositoriesOn(db).auditEvents.read(reader);
    expect(read).toEqual([
      {
        _id: 'audit:a1',
        actor: 'system',
        correlationId: CORRELATION,
        at: AT,
        action: 'integration.call',
        subject: 'anthropic claude-3-haiku',
        detail: 'resolving a book name for content import',
        outcome: 'allowed',
        requestTokens: 42,
        responseTokens: 17,
        durationMs: 812,
      },
    ]);
  });

  it('omits requestTokens, responseTokens and durationMs individually when absent, rather than writing null', async () => {
    const db = fakeDb();
    const trail = trailOn(db);
    const context = auditContext('system', CORRELATION);
    await trail.record(context, { action: 'integration.call', subject: 'anthropic claude-3-haiku', outcome: 'refused' });
    const [entry] = entries(db);
    expect(entry).not.toHaveProperty('requestTokens');
    expect(entry).not.toHaveProperty('responseTokens');
    expect(entry).not.toHaveProperty('durationMs');
  });
});

describe('what an entry could never be made to carry', () => {
  it('has no field sized or named to hold a prompt, a raw request/response body, or headers', () => {
    expect(Object.keys(CATEGORY_OF).length).toBeGreaterThan(0); // keeps this suite from being a no-op if the block below is ever removed
    // Excess-property checking on an object literal is TypeScript's own proof that AuditEntry's key set is
    // closed to exactly action | subject | outcome | detail | requestTokens | responseTokens | durationMs.
    // @ts-expect-error -- prompt is not a field AuditEntry declares, and it never should be
    const withPrompt: AuditEntry = { action: 'integration.call', subject: 'x', outcome: 'allowed', prompt: 'never' };
    // @ts-expect-error -- headers is not a field AuditEntry declares, and it never should be
    const withHeaders: AuditEntry = { action: 'integration.call', subject: 'x', outcome: 'allowed', headers: {} };
    // @ts-expect-error -- body is not a field AuditEntry declares, and it never should be
    const withBody: AuditEntry = { action: 'integration.call', subject: 'x', outcome: 'allowed', body: 'raw' };
    expect([withPrompt, withHeaders, withBody]).toHaveLength(3);
  });
});
