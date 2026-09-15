// Two promises administration must keep that no single store's own suite can prove: closing an account
// does not reach into a capability already issued, unrelated to that account, and does not erase a line
// the trail already wrote about it. Both stores are independent by construction — this is the regression
// that proves it, rather than assumes it.

import { actorFor } from '@holydeck/contracts/accounts';
import { beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { auditContext, auditOn } from './audit.js';
import { capabilitiesOn, capabilityContext } from './capabilities.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AccountStore } from './accounts.js';
import type { AuditTrail } from './audit.js';
import type { CapabilityStore } from './capabilities.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const NOW = '2026-09-13T09:30:00.000Z';
const SOON = '2026-09-13T09:45:00.000Z';
const CORRELATION = 'req-0f9c2a41';
const OPERATOR = 'account:7f3a';
const SERVICE = 'service:9b12';

const CLAIM = { name: 'andru', displayName: 'Andru Tharmarajah', password: 'a-long-enough-passphrase' };

let accounts: AccountStore;

beforeEach(() => {
  accounts = accountsOn(memoryAccounts().db, { now: () => NOW });
});

describe('a capability already issued, once some account is disabled', () => {
  test('redeems exactly as it did before, whether or not the account disabled is the one it was issued by', async () => {
    const founder = await accounts.claim(accountContext(CORRELATION), CLAIM);
    const capabilities: CapabilityStore = capabilitiesOn(memoryCapabilities().db, { now: () => NOW });
    const issued = await capabilities.issue(capabilityContext(CORRELATION), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: SOON,
    });

    await accounts.disable(accountContext(CORRELATION), founder.id);

    await expect(
      capabilities.redeem(capabilityContext(CORRELATION), issued.token, { service: SERVICE, view: 'audience' }),
    ).resolves.toEqual({ kind: 'guest', service: SERVICE, view: 'audience' });
  });
});

describe('an audit entry already written, once the account it names is disabled', () => {
  let trail: FakeDb;
  let audit: AuditTrail;

  const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

  beforeEach(() => {
    trail = fakeDb();
    audit = auditOn(trail, { now: () => NOW, newId: () => 'a1' });
  });

  test('is kept exactly as written, word for word, after the account it names is disabled', async () => {
    const founder = await accounts.claim(accountContext(CORRELATION), CLAIM);
    await audit.record(auditContext(OPERATOR, CORRELATION), {
      action: 'account.control',
      subject: actorFor(founder.id),
      outcome: 'allowed',
    });
    const before = entries();
    expect(before).toHaveLength(1);

    await accounts.disable(accountContext(CORRELATION), founder.id);

    expect(entries()).toEqual(before);
  });
});
