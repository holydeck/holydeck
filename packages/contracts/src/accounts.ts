// What an account is, as a client and a server both have to agree it is, and what claiming a fresh
// instance takes. Nothing here stores or checks a password: a password becomes a stored secret through a
// key-derivation function the browser has no business running, and only the rules a form can show —
// a length floor, a ceiling, and the shape of a handle — belong on both sides of the wire.
//
// The one path in this file is here rather than beside its routes because the guard on mutating requests
// has to name the claim as the one change a request with no session may make, and a guard that imported
// the routes it guards would be a circle.

import { FIELD_CODES, type Parsed, type Problem, parseObject } from './problems.js';
import { SECOND_FACTOR, normalizedCode } from './totp.js';

/** Where a fresh instance is claimed, and where a claimed one answers as a path that is not served. */
export const ONBOARDING_PATH = '/api/v1/onboarding';

/** Where an account is administered — today, only Control presentation, granted and revoked apart from role. */
export const ACCOUNTS_PATH = '/api/v1/accounts';

/** The three roles the permission model names. Admin first: it is the one a first run creates. */
export const ACCOUNT_ROLES = ['admin', 'editor', 'member'] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface Bounds {
  readonly minimum: number;
  readonly maximum: number;
}

/** 16 bytes of randomness, which is 22 characters of base64url and nothing another account guesses. */
export const ACCOUNT_ID_BYTES = 16;

/** Long enough to tell two people apart, short enough to type, and one case so two cannot look alike. */
export const ACCOUNT_NAME: Bounds = Object.freeze({ minimum: 3, maximum: 32 });

export const DISPLAY_NAME: Bounds = Object.freeze({ minimum: 1, maximum: 64 });

/**
 * Length is the whole rule. A floor of twelve characters and no composition demand is what ASVS asks for
 * and what people answer with a passphrase rather than with a word and a digit; the ceiling is there so a
 * megabyte of text cannot be handed to a deliberately slow hash.
 */
export const PASSWORD: Bounds = Object.freeze({ minimum: 12, maximum: 128 });

const ID = /^[A-Za-z0-9_-]{22,43}$/u;

const NAME = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/u;

export const isAccountId = (value: string): boolean => ID.test(value);

export const isAccountName = (value: string): boolean => NAME.test(value);

const ACTOR_PREFIX = 'account:';

/** How an account appears in a durable record and in a request context: never as the bare identifier. */
export const actorFor = (id: string): string => `${ACTOR_PREFIX}${id}`;

/**
 * The identifier back out of that name, and nothing for an actor that is not an account. A record is
 * written by whoever made it — a session, a migration, this server itself — and only some of those are
 * people; code that needs the account behind an actor has to be told plainly when there is not one.
 */
export const accountIdIn = (actor: string): string | undefined => {
  const id = actor.startsWith(ACTOR_PREFIX) ? actor.slice(ACTOR_PREFIX.length) : '';
  return isAccountId(id) ? id : undefined;
};

const NAME_RULE = `must be ${ACCOUNT_NAME.minimum} to ${ACCOUNT_NAME.maximum} lowercase letters, digits, dots, dashes or underscores, beginning and ending with a letter or digit`;

/** Counted in characters a person typed rather than in the bytes they take, which differ by alphabet. */
const characters = (value: string): number => [...value].length;

/**
 * Whether a password is one this system will store, and why not when it is not. Returned rather than
 * thrown, and shaped as a field problem, because both the claim here and a later password change answer
 * with it. A password is compared after the same normalisation on both sides: a keyboard decides whether
 * an accent arrives as one character or as two, and a person who typed one password typed one password.
 */
export function passwordProblem(password: string): Problem | undefined {
  const length = characters(password.normalize('NFKC'));
  if (length < PASSWORD.minimum) {
    return { path: 'password', code: FIELD_CODES.tooSmall, message: `must be at least ${PASSWORD.minimum} characters` };
  }
  if (length > PASSWORD.maximum) {
    return { path: 'password', code: FIELD_CODES.notAllowed, message: `must be at most ${PASSWORD.maximum} characters` };
  }
  return undefined;
}

export interface AccountRecord {
  readonly id: string;
  /** The handle the account is signed in under. One case, one shape, and unique across the instance. */
  readonly name: string;
  readonly displayName: string;
  readonly role: AccountRole;
  readonly createdAt: string;
  /** Administered on its own, apart from the three roles. Neither admin nor editor holds it implicitly. */
  readonly controlPresentation: boolean;
  /** Not deleted, not renamed, kept in every other respect — this is the entire distinction of being closed. */
  readonly disabled: boolean;
}

export function parseAccountRecord(value: unknown): Parsed<AccountRecord> {
  return parseObject(value, 'account', (reader) => {
    const record = {
      id: reader.text('id'),
      name: reader.text('name'),
      displayName: reader.text('displayName'),
      role: reader.choice('role', ACCOUNT_ROLES),
      createdAt: reader.time('createdAt'),
      controlPresentation: reader.flag('controlPresentation'),
      disabled: reader.flag('disabled'),
    };
    if (record.id !== '' && !isAccountId(record.id)) {
      reader.reject('id', FIELD_CODES.notAllowed, 'must be an opaque identifier this server issued');
    }
    if (record.name !== '' && !isAccountName(record.name)) reader.reject('name', FIELD_CODES.notAllowed, NAME_RULE);
    return record;
  });
}

/** What granting or revoking Control presentation takes: the one flag that says which it now is. */
export interface ControlGrant {
  readonly granted: boolean;
}

export function parseControlGrant(value: unknown): Parsed<ControlGrant> {
  return parseObject(value, 'grant', (reader) => ({ granted: reader.flag('granted') }));
}

/** What an Admin creating an account beyond the one founder `claim()` made is asked for: a claim, plus a role. */
export interface CreateAccount {
  readonly name: string;
  readonly displayName: string;
  readonly password: string;
  readonly role: AccountRole;
}

/**
 * Graded exactly as `parseInstanceClaim` grades a first run's claim — the same handle, display name and
 * password rules — because an account made here is subject to no laxer a rule than one made by claiming.
 * Not `parseInstanceClaim` itself: that function is the onboarding claim, one account with one fixed role,
 * and this one is a sibling for a different operation, an Admin naming the role a new account gets.
 */
export function parseCreateAccount(value: unknown): Parsed<CreateAccount> {
  return parseObject(value, 'newAccount', (reader) => {
    const typedName = reader.text('name');
    const name = typedName.trim().toLowerCase();
    if (typedName !== '' && !isAccountName(name)) reader.reject('name', FIELD_CODES.notAllowed, NAME_RULE);
    const typedDisplayName = reader.text('displayName');
    const displayName = typedDisplayName.trim();
    if (typedDisplayName !== '' && displayName === '') {
      reader.reject('displayName', FIELD_CODES.empty, 'must not be only spaces');
    }
    if (characters(displayName) > DISPLAY_NAME.maximum) {
      reader.reject('displayName', FIELD_CODES.notAllowed, `must be at most ${DISPLAY_NAME.maximum} characters`);
    }
    const typedPassword = reader.text('password');
    const password = typedPassword.normalize('NFKC');
    const problem = typedPassword === '' ? undefined : passwordProblem(password);
    if (problem !== undefined) reader.reject('password', problem.code, problem.message);
    const role = reader.choice('role', ACCOUNT_ROLES);
    return { name, displayName, password, role };
  });
}

/** What closing an account or reopening it takes: the one flag that says which it now is. */
export interface AccountStatus {
  readonly disabled: boolean;
}

export function parseAccountStatus(value: unknown): Parsed<AccountStatus> {
  return parseObject(value, 'status', (reader) => ({ disabled: reader.flag('disabled') }));
}

/** What reassigning an account's role takes: the one role it now holds, out of the three this system names. */
export interface RoleAssignment {
  readonly role: AccountRole;
}

export function parseRoleAssignment(value: unknown): Parsed<RoleAssignment> {
  return parseObject(value, 'roleAssignment', (reader) => ({ role: reader.choice('role', ACCOUNT_ROLES) }));
}

/** What a first run is asked for: a handle to sign in under, a name to show, and a password. */
export interface InstanceClaim {
  readonly name: string;
  readonly displayName: string;
  readonly password: string;
}

export function parseInstanceClaim(value: unknown): Parsed<InstanceClaim> {
  return parseObject(value, 'claim', (reader) => {
    // Trimmed and lowered before it is graded, because a handle typed with a capital or a trailing space
    // is the handle the person meant, and refusing it teaches them to distrust the form instead.
    const typedName = reader.text('name');
    const name = typedName.trim().toLowerCase();
    if (typedName !== '' && !isAccountName(name)) reader.reject('name', FIELD_CODES.notAllowed, NAME_RULE);
    const typedDisplayName = reader.text('displayName');
    const displayName = typedDisplayName.trim();
    if (typedDisplayName !== '' && displayName === '') {
      reader.reject('displayName', FIELD_CODES.empty, 'must not be only spaces');
    }
    if (characters(displayName) > DISPLAY_NAME.maximum) {
      reader.reject('displayName', FIELD_CODES.notAllowed, `must be at most ${DISPLAY_NAME.maximum} characters`);
    }
    const typedPassword = reader.text('password');
    const password = typedPassword.normalize('NFKC');
    const problem = typedPassword === '' ? undefined : passwordProblem(password);
    if (problem !== undefined) reader.reject('password', problem.code, problem.message);
    return { name, displayName, password };
  });
}

/** What signing in takes: the handle an account is known by, and the password it was claimed with. */
export interface SignIn {
  readonly name: string;
  readonly password: string;
  /** The second factor, when the account has one and the person typed it. Absent is not a refusal here. */
  readonly code?: string;
}

/**
 * Reads a sign-in the same way a claim is read, and grades it deliberately less. Only the ceilings are
 * enforced, because they are the guard on handing a megabyte to a slow hash and nothing else. A floor, or
 * the shape of a handle, is a rule about what may be created — and applying it here would strand every
 * account made before the rule changed, answering somebody who knows their own password with a validation
 * problem instead of letting them in. Being wrong is the store's answer to give, and it gives one answer.
 */
export function parseSignIn(value: unknown): Parsed<SignIn> {
  return parseObject(value, 'credentials', (reader) => {
    const name = reader.text('name').trim().toLowerCase();
    if (characters(name) > ACCOUNT_NAME.maximum) {
      reader.reject('name', FIELD_CODES.notAllowed, `must be at most ${ACCOUNT_NAME.maximum} characters`);
    }
    const password = reader.text('password').normalize('NFKC');
    if (characters(password) > PASSWORD.maximum) {
      reader.reject('password', FIELD_CODES.notAllowed, `must be at most ${PASSWORD.maximum} characters`);
    }
    // A code is optional at this layer whether or not the account has a second factor: which accounts have
    // one is the store's knowledge, and answering "that account needs a code" to a form is the enumeration
    // this route exists not to do. Typed nothing and sent nothing are the same thing, and both are absent.
    const typedCode = reader.optionalText('code') ?? '';
    if (characters(typedCode) > SECOND_FACTOR.maximum) {
      reader.reject('code', FIELD_CODES.notAllowed, `must be at most ${SECOND_FACTOR.maximum} characters`);
    }
    const code = normalizedCode(typedCode);
    return code === '' ? { name, password } : { name, password, code };
  });
}

export interface OnboardingOffer {
  /** What the account a claim creates will be. There is one, and this is it. */
  readonly role: AccountRole;
  readonly name: Bounds;
  readonly password: Bounds;
}

/** What a client is told before it shows the form, so the rules it enforces are the server's own. */
export const onboardingOffer = (): OnboardingOffer =>
  Object.freeze({ role: 'admin' as const, name: ACCOUNT_NAME, password: PASSWORD });
