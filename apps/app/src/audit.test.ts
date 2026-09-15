import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, auditContext, auditOn } from './audit.js';
import { ContextError, requestContext } from './context.js';
import { RepositoryError } from './repositories.js';
import { fakeDb } from '../test/helpers/fake-db.js';

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
      'session.slot.add',
      'session.slot.switch',
      'capability.guest.issue',
      'capability.output.issue',
      'capability.revoke',
    ]);
  });
});
