import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ID_BYTES,
  ACCOUNT_NAME,
  ACCOUNT_ROLES,
  ACCOUNTS_PATH,
  DISPLAY_NAME,
  ONBOARDING_PATH,
  PASSWORD,
  accountIdIn,
  actorFor,
  isAccountId,
  isAccountName,
  onboardingOffer,
  parseAccountRecord,
  parseAccountStatus,
  parseControlGrant,
  parseCreateAccount,
  parseInstanceClaim,
  parseRoleAssignment,
  parseSignIn,
  passwordProblem,
} from './accounts.js';
import { FIELD_CODES } from './problems.js';

import type { AccountRecord } from './accounts.js';

const ID = 'GLkQ5wEtQEy5PfN2Zr9m7A';

const RECORD: AccountRecord = {
  id: ID,
  name: 'andru',
  displayName: 'Andru Tharmarajah',
  role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z',
  controlPresentation: false,
  disabled: false,
};

const CLAIM = { name: 'Andru ', displayName: ' Andru Tharmarajah ', password: 'a-long-enough-passphrase' };

const codes = (value: unknown): string[] => {
  const parsed = parseInstanceClaim(value);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

describe('what an account is', () => {
  it('is one of the three roles the permission model names, admin first', () => {
    expect(ACCOUNT_ROLES).toEqual(['admin', 'editor', 'member']);
  });

  it('is acted under a name the durable records carry, which is never the raw identifier', () => {
    expect(actorFor(ID)).toBe(`account:${ID}`);
  });

  it('is read back out of that name, and nothing that is not one reads back as an account', () => {
    expect(accountIdIn(actorFor(ID))).toBe(ID);
    for (const actor of ['system', `account:${'!'.repeat(22)}`, 'account:', `account:${ID}:extra`, ID]) {
      expect(accountIdIn(actor)).toBeUndefined();
    }
  });

  it('is identified by enough randomness that no one guesses another account’s identifier', () => {
    expect(ACCOUNT_ID_BYTES).toBeGreaterThanOrEqual(16);
    expect(isAccountId(ID)).toBe(true);
    expect(isAccountId('7f3a')).toBe(false);
    expect(isAccountId(`${ID}/../admin`)).toBe(false);
  });

  it('is signed in under a handle of one settled shape, so two accounts cannot look alike', () => {
    expect(isAccountName('andru')).toBe(true);
    expect(isAccountName('andru.t_2-x')).toBe(true);
    expect(isAccountName('an')).toBe(false);
    expect(isAccountName('a'.repeat(ACCOUNT_NAME.maximum + 1))).toBe(false);
    expect(isAccountName('Andru')).toBe(false);
    expect(isAccountName('.andru')).toBe(false);
    expect(isAccountName('andru.')).toBe(false);
    expect(isAccountName('andru tharmarajah')).toBe(false);
  });

  it('reads back as itself, which is what the store writing one grades it against', () => {
    const parsed = parseAccountRecord(RECORD);
    expect(parsed.ok && parsed.value).toEqual(RECORD);
  });

  it('reports every field a record is missing at once rather than the first one', () => {
    const parsed = parseAccountRecord({});
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'account.id',
      'account.name',
      'account.displayName',
      'account.role',
      'account.createdAt',
      'account.controlPresentation',
      'account.disabled',
    ]);
  });

  // Control presentation is administered on its own, apart from the three roles: an account carries
  // whether it holds it as plainly as it carries its role, and neither an admin nor an editor is read as
  // holding it just because a record happens to say so about their role.
  it('carries whether it holds Control presentation, independently of its role', () => {
    const grantedRecord = { ...RECORD, controlPresentation: true };
    expect(parseAccountRecord(grantedRecord)).toEqual({ ok: true, value: grantedRecord });
    expect(parseAccountRecord(RECORD)).toEqual({ ok: true, value: RECORD });
  });

  it('refuses a record whose Control presentation flag is not a plain boolean', () => {
    const parsed = parseAccountRecord({ ...RECORD, controlPresentation: 'yes' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'account.controlPresentation', code: FIELD_CODES.notABoolean, message: 'must be true or false' },
    ]);
  });

  it('refuses a record whose identifier or handle this code could not have written', () => {
    const parsed = parseAccountRecord({ ...RECORD, id: 'short', name: 'Andru' });
    expect(!parsed.ok && parsed.problems.map((problem) => `${problem.path}=${problem.code}`)).toEqual([
      `account.id=${FIELD_CODES.notAllowed}`,
      `account.name=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a role nothing grants, rather than reading it as the first one', () => {
    const parsed = parseAccountRecord({ ...RECORD, role: 'owner' });
    expect(!parsed.ok && parsed.problems.map((problem) => `${problem.path}=${problem.code}`)).toEqual([
      `account.role=${FIELD_CODES.notAllowed}`,
    ]);
  });
});

describe('what a password has to be', () => {
  it('is long rather than complicated: a length floor, a ceiling, and no composition rule at all', () => {
    expect(PASSWORD.minimum).toBeGreaterThanOrEqual(12);
    expect(PASSWORD.maximum).toBeGreaterThanOrEqual(64);
    expect(passwordProblem('a-long-enough-passphrase')).toBeUndefined();
    expect(passwordProblem('☕'.repeat(PASSWORD.minimum))).toBeUndefined();
  });

  it('is refused for being short or for being longer than anything a deployment will store', () => {
    expect(passwordProblem('a'.repeat(PASSWORD.minimum - 1))).toMatchObject({
      path: 'password',
      code: FIELD_CODES.tooSmall,
    });
    expect(passwordProblem('a'.repeat(PASSWORD.maximum + 1))).toMatchObject({
      path: 'password',
      code: FIELD_CODES.notAllowed,
    });
  });

  it('is measured in characters a person typed, not in the bytes they happen to take', () => {
    // Twelve emoji are twelve characters to whoever typed them, and forty-eight bytes to a machine.
    expect(passwordProblem('🕊'.repeat(PASSWORD.minimum))).toBeUndefined();
    expect(passwordProblem('🕊'.repeat(PASSWORD.minimum - 1))).toBeDefined();
  });
});

describe('claiming an instance', () => {
  it('is offered at one path, which a client asks for before it shows a form', () => {
    expect(ONBOARDING_PATH).toBe('/api/v1/onboarding');
    expect(onboardingOffer()).toEqual({ role: 'admin', name: ACCOUNT_NAME, password: PASSWORD });
  });

  it('takes a handle, a name to show, and a password, and settles the shape of each', () => {
    const parsed = parseInstanceClaim(CLAIM);
    expect(parsed.ok && parsed.value).toEqual({
      name: 'andru',
      displayName: 'Andru Tharmarajah',
      password: 'a-long-enough-passphrase',
    });
  });

  it('reads a password as the characters it was typed as, however they were composed', () => {
    // One passphrase, typed twice: once with the single character for an accented e, and once with
    // the letter and a combining accent after it. A keyboard decides which arrives; a person typed one.
    const composed = parseInstanceClaim({ ...CLAIM, password: 'caf\u00e9-passphrase-x' });
    const decomposed = parseInstanceClaim({ ...CLAIM, password: 'cafe\u0301-passphrase-x' });
    expect(composed.ok && composed.value.password).toBe('caf\u00e9-passphrase-x');
    expect(decomposed.ok && decomposed.value.password).toBe(composed.ok && composed.value.password);
  });

  it('refuses a payload that is not one, rather than reading fields off nothing', () => {
    expect(codes('andru')).toEqual([`claim=${FIELD_CODES.notAnObject}`]);
  });

  it('names every field a claim is missing at once, in the order the form asks for them', () => {
    expect(codes({})).toEqual([
      `claim.name=${FIELD_CODES.required}`,
      `claim.displayName=${FIELD_CODES.required}`,
      `claim.password=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a handle no account may be signed in under, once, and says which field', () => {
    expect(codes({ ...CLAIM, name: 'an' })).toEqual([`claim.name=${FIELD_CODES.notAllowed}`]);
    expect(codes({ ...CLAIM, name: '' })).toEqual([`claim.name=${FIELD_CODES.empty}`]);
  });

  it('refuses a name to show that is nothing but spaces, which is a name nobody would recognise', () => {
    expect(codes({ ...CLAIM, displayName: '   ' })).toEqual([`claim.displayName=${FIELD_CODES.empty}`]);
    expect(codes({ ...CLAIM, displayName: 'x'.repeat(DISPLAY_NAME.maximum + 1) })).toEqual([
      `claim.displayName=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a password the deployment would not store, and says so as a field problem', () => {
    expect(codes({ ...CLAIM, password: 'short' })).toEqual([`claim.password=${FIELD_CODES.tooSmall}`]);
    expect(codes({ ...CLAIM, password: '' })).toEqual([`claim.password=${FIELD_CODES.empty}`]);
  });

  it('refuses a field that is not text, and does not also complain about its shape', () => {
    expect(codes({ name: 4, displayName: false, password: null })).toEqual([
      `claim.name=${FIELD_CODES.notText}`,
      `claim.displayName=${FIELD_CODES.notText}`,
      `claim.password=${FIELD_CODES.notText}`,
    ]);
  });
});

describe('signing in', () => {
  it('reads a handle and a password after the same normalisation the claim applied to them', () => {
    const parsed = parseSignIn({ name: '  Andru  ', password: 'cafe\u0301-passphrase-x' });
    expect(parsed).toEqual({ ok: true, value: { name: 'andru', password: 'caf\u00e9-passphrase-x' } });
  });

  it('refuses a body that is not an object before it looks for a field in one', () => {
    expect(parseSignIn('andru')).toEqual({
      ok: false,
      problems: [{ path: 'credentials', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('names both fields at once when neither is there, under the object they belong to', () => {
    const parsed = parseSignIn({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problems.map((problem) => problem.path)).toEqual(['credentials.name', 'credentials.password']);
    expect(parsed.problems.every((problem) => problem.code === FIELD_CODES.required)).toBe(true);
  });

  it('refuses an empty handle or an empty password rather than carrying it to the store as a guess', () => {
    const parsed = parseSignIn({ name: '', password: '' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problems.map((problem) => problem.code)).toEqual([FIELD_CODES.empty, FIELD_CODES.empty]);
  });

  it('refuses either field past its ceiling, because a megabyte must never reach a deliberately slow hash', () => {
    const parsed = parseSignIn({ name: 'a'.repeat(ACCOUNT_NAME.maximum + 1), password: 'x'.repeat(PASSWORD.maximum + 1) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problems.map((problem) => problem.path)).toEqual(['credentials.name', 'credentials.password']);
  });

  // The two rules a claim enforces and signing in deliberately does not. A floor or a handle rule that
  // changed after an account was made would otherwise strand that account: its password and its handle
  // were legal the day they were chosen, and refusing them now would answer the person who knows their
  // password with a validation problem instead of letting them in.
  it('reads a password under the floor a claim enforces rather than refusing it', () => {
    expect(parseSignIn({ name: 'andru', password: 'short' })).toEqual({
      ok: true,
      value: { name: 'andru', password: 'short' },
    });
  });

  it('carries a second factor when one was typed, spaced the way it was shown and no other rule applied', () => {
    expect(parseSignIn({ name: 'andru', password: 'a-passphrase-worth-typing', code: ' 123-456 ' })).toEqual({
      ok: true,
      value: { name: 'andru', password: 'a-passphrase-worth-typing', code: '123456' },
    });
    const long = parseSignIn({ name: 'andru', password: 'a-passphrase-worth-typing', code: 'A'.repeat(65) });
    expect(long.ok).toBe(false);
    if (long.ok) throw new Error('unreachable');
    expect(long.problems.map((problem) => problem.path)).toEqual(['credentials.code']);
  });

  it('carries no second factor when none was typed, which is what an account without one sends', () => {
    const parsed = parseSignIn({ name: 'andru', password: 'a-passphrase-worth-typing' });
    expect(parsed.ok && parsed.value.code).toBeUndefined();
    const typedNothing = parseSignIn({ name: 'andru', password: 'a-passphrase-worth-typing', code: '' });
    expect(typedNothing.ok && typedNothing.value.code).toBeUndefined();
  });

  it('reads a handle no claim could have created rather than refusing it', () => {
    expect(isAccountName('_andru_')).toBe(false);
    expect(parseSignIn({ name: '_andru_', password: 'a-passphrase-worth-typing' })).toEqual({
      ok: true,
      value: { name: '_andru_', password: 'a-passphrase-worth-typing' },
    });
  });
});

describe('granting or revoking Control presentation', () => {
  it('is administered at one path, under the account it is granted or revoked for', () => {
    expect(ACCOUNTS_PATH).toBe('/api/v1/accounts');
  });

  it('reads whether it is granted, and only that', () => {
    expect(parseControlGrant({ granted: true })).toEqual({ ok: true, value: { granted: true } });
    expect(parseControlGrant({ granted: false })).toEqual({ ok: true, value: { granted: false } });
  });

  it('refuses a body that is not an object before it looks for a field in one', () => {
    expect(parseControlGrant('yes')).toEqual({
      ok: false,
      problems: [{ path: 'grant', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('refuses a grant that does not say whether it is one', () => {
    expect(parseControlGrant({})).toEqual({
      ok: false,
      problems: [{ path: 'grant.granted', code: FIELD_CODES.required, message: 'is required' }],
    });
  });

  it('refuses a granted flag that is not a plain boolean', () => {
    expect(parseControlGrant({ granted: 'true' })).toEqual({
      ok: false,
      problems: [{ path: 'grant.granted', code: FIELD_CODES.notABoolean, message: 'must be true or false' }],
    });
  });
});

describe('creating an account beyond the one the founder claims', () => {
  it('takes a handle, a name to show, a password and a role, graded the same as a claim', () => {
    const parsed = parseCreateAccount({ ...CLAIM, role: 'editor' });
    expect(parsed.ok && parsed.value).toEqual({
      name: 'andru',
      displayName: 'Andru Tharmarajah',
      password: 'a-long-enough-passphrase',
      role: 'editor',
    });
  });

  it('names every field it is missing at once, the role among them', () => {
    const parsed = parseCreateAccount({});
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'newAccount.name',
      'newAccount.displayName',
      'newAccount.password',
      'newAccount.role',
    ]);
  });

  it('refuses a role nothing grants, rather than reading it as the first one', () => {
    const parsed = parseCreateAccount({ ...CLAIM, role: 'owner' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'newAccount.role', code: FIELD_CODES.notAllowed, message: expect.any(String) },
    ]);
  });

  it('refuses a handle no account may be signed in under, once, and says which field', () => {
    const parsed = parseCreateAccount({ ...CLAIM, name: 'an', role: 'editor' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'newAccount.name', code: FIELD_CODES.notAllowed, message: expect.any(String) },
    ]);
  });

  it('refuses a password the deployment would not store, and says so as a field problem', () => {
    const parsed = parseCreateAccount({ ...CLAIM, password: 'short', role: 'editor' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'newAccount.password', code: FIELD_CODES.tooSmall, message: expect.any(String) },
    ]);
  });

  it('refuses a name to show that is nothing but spaces, which is a name nobody would recognise', () => {
    const parsed = parseCreateAccount({ ...CLAIM, displayName: '   ', role: 'editor' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'newAccount.displayName', code: FIELD_CODES.empty, message: expect.any(String) },
    ]);
    const long = parseCreateAccount({ ...CLAIM, displayName: 'x'.repeat(DISPLAY_NAME.maximum + 1), role: 'editor' });
    expect(!long.ok && long.problems).toEqual([
      { path: 'newAccount.displayName', code: FIELD_CODES.notAllowed, message: expect.any(String) },
    ]);
  });
});

describe('closing an account, and reopening it', () => {
  it('reads whether it is now closed, and only that', () => {
    expect(parseAccountStatus({ disabled: true })).toEqual({ ok: true, value: { disabled: true } });
    expect(parseAccountStatus({ disabled: false })).toEqual({ ok: true, value: { disabled: false } });
  });

  it('refuses a body that does not say whether it is closed', () => {
    expect(parseAccountStatus({})).toEqual({
      ok: false,
      problems: [{ path: 'status.disabled', code: FIELD_CODES.required, message: 'is required' }],
    });
  });

  it('refuses a disabled flag that is not a plain boolean', () => {
    expect(parseAccountStatus({ disabled: 'yes' })).toEqual({
      ok: false,
      problems: [{ path: 'status.disabled', code: FIELD_CODES.notABoolean, message: 'must be true or false' }],
    });
  });
});

describe('reassigning which of the three roles an account holds', () => {
  it('reads the role it is now assigned, and only that', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(parseRoleAssignment({ role })).toEqual({ ok: true, value: { role } });
    }
  });

  it('refuses a body that does not name a role', () => {
    expect(parseRoleAssignment({})).toEqual({
      ok: false,
      problems: [{ path: 'roleAssignment.role', code: FIELD_CODES.required, message: 'is required' }],
    });
  });

  it('refuses a role nothing grants, rather than reading it as the first one', () => {
    const parsed = parseRoleAssignment({ role: 'owner' });
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'roleAssignment.role', code: FIELD_CODES.notAllowed, message: expect.any(String) },
    ]);
  });
});
