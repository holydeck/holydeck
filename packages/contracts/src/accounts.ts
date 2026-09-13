// What an account is, as a client and a server both have to agree it is, and what claiming a fresh
// instance takes. Nothing here stores or checks a password: a password becomes a stored secret through a
// key-derivation function the browser has no business running, and only the rules a form can show —
// a length floor, a ceiling, and the shape of a handle — belong on both sides of the wire.
//
// The one path in this file is here rather than beside its routes because the guard on mutating requests
// has to name the claim as the one change a request with no session may make, and a guard that imported
// the routes it guards would be a circle.

import { FIELD_CODES, type Parsed, type Problem, parseObject } from './problems.js';

/** Where a fresh instance is claimed, and where a claimed one answers as a path that is not served. */
export const ONBOARDING_PATH = '/api/v1/onboarding';

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

/** How an account appears in a durable record and in a request context: never as the bare identifier. */
export const actorFor = (id: string): string => `account:${id}`;

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
}

export function parseAccountRecord(value: unknown): Parsed<AccountRecord> {
  return parseObject(value, 'account', (reader) => {
    const record = {
      id: reader.text('id'),
      name: reader.text('name'),
      displayName: reader.text('displayName'),
      role: reader.choice('role', ACCOUNT_ROLES),
      createdAt: reader.time('createdAt'),
    };
    if (record.id !== '' && !isAccountId(record.id)) {
      reader.reject('id', FIELD_CODES.notAllowed, 'must be an opaque identifier this server issued');
    }
    if (record.name !== '' && !isAccountName(record.name)) reader.reject('name', FIELD_CODES.notAllowed, NAME_RULE);
    return record;
  });
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
    return { name, password };
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
