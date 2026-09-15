// A passkey, as a browser and a server both have to agree one is.
//
// Nothing here verifies a signature or holds a public key. What travels is where a passkey is
// registered, renamed and revoked, the parameters both halves of a ceremony assume, and the shape the
// two payloads a browser produces have once they are on the wire. The point of parsing them here is
// the ceiling: a credential arrives as base64url text that the server hands to a CBOR decoder and a
// signature check, and neither of those should ever be handed a megabyte by somebody who typed one.

import { FIELD_CODES, type ParseFn, type Parsed, isRecord, parseObject } from './problems.js';

import type { Bounds } from './accounts.js';
import type { FieldReader } from './problems.js';

/** Where an account's passkeys are listed and registered, and where one of them is named or revoked. */
export const PASSKEY_PATH = '/api/v1/passkeys';

/** Where a ceremony starts: the challenge, the relying party, and the keys this account already has. */
export const PASSKEY_OPTIONS_PATH = `${PASSKEY_PATH}/options`;

/** A credential identifier is chosen by an authenticator, not by this server, so it is escaped. */
export const passkeyPath = (id: string): string => `${PASSKEY_PATH}/${encodeURIComponent(id)}`;

/** What a browser shows when it asks whether to save a passkey, and what an authenticator stores. */
export const RELYING_PARTY_NAME = 'HolyDeck';

/**
 * How long a challenge is worth answering. Two minutes is a fingerprint, a PIN or a phone held up to a
 * screen, with room to fetch the phone; longer only widens the window a stolen challenge is useful in.
 */
export const CHALLENGE_SECONDS = 120;

/** What a person calls a key so they can tell it from the others when the time comes to revoke one. */
export const PASSKEY_LABEL: Bounds = Object.freeze({ minimum: 1, maximum: 64 });

/** Enough for a phone, a laptop, and the spares either of them was replaced by. Not a list to scroll. */
export const PASSKEY_LIMIT = 20;

/**
 * The ceiling every base64url field in a ceremony is graded against, before anything decodes one. An
 * attestation object with a certificate chain in it is a few kilobytes; this is room for that and no
 * room for the request whose only purpose is to see what a CBOR decoder does with eight megabytes.
 */
export const CEREMONY_FIELD: Bounds = Object.freeze({ minimum: 1, maximum: 8192 });

/** What a browser reports about how it reached the authenticator, and all this server makes sense of. */
export const TRANSPORTS = ['internal', 'hybrid', 'usb', 'nfc', 'ble'] as const;

export type PasskeyTransport = (typeof TRANSPORTS)[number];

/** The two halves of signing in with a passkey: ask for a challenge, then answer the one you were given. */
export const PASSKEY_STEPS = ['challenge', 'assertion'] as const;

export type PasskeyStep = (typeof PASSKEY_STEPS)[number];

export interface RegistrationCredential {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly clientDataJSON: string;
  readonly attestationObject: string;
  readonly transports: readonly PasskeyTransport[];
}

export interface PasskeyRegistration {
  readonly name: string;
  readonly credential: RegistrationCredential;
}

export interface PasskeyAssertion {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly userHandle?: string;
}

export type PasskeySignIn = { readonly step: 'challenge' } | { readonly step: 'assertion'; readonly assertion: PasskeyAssertion };

export interface PasskeyName {
  readonly name: string;
}

/** What a list of an account's passkeys says about each one. No public key and no counter: neither is theirs to read. */
export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly registeredAt: string;
  readonly lastUsedAt?: string;
  readonly transports: readonly PasskeyTransport[];
  /** Whether the authenticator says this key is backed up, which is what makes losing the device survivable. */
  readonly synced: boolean;
}

/** Counted in characters a person typed rather than in the bytes they take, which differ by alphabet. */
const characters = (value: string): number => [...value].length;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * One field of a ceremony: text, within the ceiling, and base64url. The order matters — a field over
 * the ceiling is refused for its length rather than matched against a pattern the whole of it first.
 */
const ceremonyField = (reader: FieldReader, name: string): string => {
  const value = reader.text(name);
  if (value === '') return value;
  if (characters(value) > CEREMONY_FIELD.maximum) {
    reader.reject(name, FIELD_CODES.notAllowed, `must be at most ${CEREMONY_FIELD.maximum} characters`);
    return value;
  }
  if (!BASE64URL.test(value)) reader.reject(name, FIELD_CODES.notAllowed, 'must be base64url');
  return value;
};

/** A label as it is stored: without the spacing around it, and short enough to read in a list. */
const label = (reader: FieldReader): string => {
  const typed = reader.text('name');
  const name = typed.trim();
  if (typed !== '' && name === '') reader.reject('name', FIELD_CODES.empty, 'must not be empty');
  if (characters(name) > PASSKEY_LABEL.maximum) {
    reader.reject('name', FIELD_CODES.notAllowed, `must be at most ${PASSKEY_LABEL.maximum} characters`);
  }
  return name;
};

const textItem: ParseFn<string> = (value, path) =>
  typeof value === 'string'
    ? { ok: true, value }
    : { ok: false, problems: [{ path, code: FIELD_CODES.notText, message: 'must be text' }] };

/**
 * A transport this server has never heard of is dropped rather than refused. The list is a hint a
 * browser offers about how to reach the key again; a new one appearing in it is not a bad request.
 */
const reportedTransports = (reader: FieldReader): readonly PasskeyTransport[] => {
  const reported = reader.optionalParsedList('transports', textItem) ?? [];
  return TRANSPORTS.filter((transport) => reported.includes(transport));
};

const parseRegistrationResponse: ParseFn<Omit<RegistrationCredential, 'id' | 'rawId' | 'type'>> = (value, path) =>
  parseObject(value, path, (reader) => ({
    clientDataJSON: ceremonyField(reader, 'clientDataJSON'),
    attestationObject: ceremonyField(reader, 'attestationObject'),
    transports: reportedTransports(reader),
  }));

const EMPTY_REGISTRATION_RESPONSE = Object.freeze({
  clientDataJSON: '',
  attestationObject: '',
  transports: [] as readonly PasskeyTransport[],
});

const parseRegistrationCredential: ParseFn<RegistrationCredential> = (value, path) =>
  parseObject(value, path, (reader) => ({
    id: ceremonyField(reader, 'id'),
    rawId: ceremonyField(reader, 'rawId'),
    type: reader.choice('type', ['public-key'] as const),
    ...reader.parsed('response', parseRegistrationResponse, EMPTY_REGISTRATION_RESPONSE),
  }));

const EMPTY_CREDENTIAL: RegistrationCredential = Object.freeze({
  id: '',
  rawId: '',
  type: 'public-key',
  ...EMPTY_REGISTRATION_RESPONSE,
});

/** Reads the credential a registration ceremony produced, with the name the person gave the key. */
export function parsePasskeyRegistration(value: unknown): Parsed<PasskeyRegistration> {
  return parseObject(value, 'passkey', (reader) => ({
    name: label(reader),
    credential: reader.parsed('credential', parseRegistrationCredential, EMPTY_CREDENTIAL),
  }));
}

/** Reads the new name for a passkey that is already registered. The key itself is not up for change. */
export function parsePasskeyName(value: unknown): Parsed<PasskeyName> {
  return parseObject(value, 'passkey', (reader) => ({ name: label(reader) }));
}

const parseAssertionResponse: ParseFn<Omit<PasskeyAssertion, 'id' | 'rawId' | 'type'>> = (value, path) =>
  parseObject(value, path, (reader) => {
    const userHandle = reader.optionalText('userHandle') === undefined ? undefined : ceremonyField(reader, 'userHandle');
    return {
      clientDataJSON: ceremonyField(reader, 'clientDataJSON'),
      authenticatorData: ceremonyField(reader, 'authenticatorData'),
      signature: ceremonyField(reader, 'signature'),
      userHandle,
    };
  });

const EMPTY_ASSERTION_RESPONSE = Object.freeze({
  clientDataJSON: '',
  authenticatorData: '',
  signature: '',
  userHandle: undefined as string | undefined,
});

const parseAssertion: ParseFn<PasskeyAssertion> = (value, path) =>
  parseObject(value, path, (reader) => ({
    id: ceremonyField(reader, 'id'),
    rawId: ceremonyField(reader, 'rawId'),
    type: reader.choice('type', ['public-key'] as const),
    ...reader.parsed('response', parseAssertionResponse, EMPTY_ASSERTION_RESPONSE),
  }));

const EMPTY_ASSERTION: PasskeyAssertion = Object.freeze({
  id: '',
  rawId: '',
  type: 'public-key',
  ...EMPTY_ASSERTION_RESPONSE,
});

/**
 * Whether a sign-in body is a passkey's rather than a password's. Told apart before either is read,
 * because the two are parsed by different code and a body that is neither must not be half-read as both.
 */
export const isPasskeySignIn = (value: unknown): boolean => isRecord(value) && value['passkey'] !== undefined;

/** Reads one step of signing in with a passkey: the request for a challenge, or the answer to one. */
export function parsePasskeySignIn(value: unknown): Parsed<PasskeySignIn> {
  if (!isRecord(value) || value['passkey'] === undefined) {
    return { ok: false, problems: [{ path: 'passkey', code: FIELD_CODES.required, message: 'is required' }] };
  }
  return parseObject(value['passkey'], 'passkey', (reader) => {
    const step = reader.choice('step', PASSKEY_STEPS);
    if (step === 'assertion') {
      return { step, assertion: reader.parsed('assertion', parseAssertion, EMPTY_ASSERTION) };
    }
    // A challenge is asked for by a browser that has nothing to answer with yet. An assertion sent
    // alongside one was signed against a challenge this request is about to replace.
    reader.absent('assertion', FIELD_CODES.notAllowed, 'must not be sent until a challenge has been issued');
    return { step: 'challenge' as const };
  });
}
