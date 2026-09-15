import { describe, expect, test } from 'vitest';

import {
  CEREMONY_FIELD,
  CHALLENGE_SECONDS,
  PASSKEY_LABEL,
  PASSKEY_LIMIT,
  PASSKEY_OPTIONS_PATH,
  PASSKEY_PATH,
  RELYING_PARTY_NAME,
  TRANSPORTS,
  isPasskeySignIn,
  parsePasskeyName,
  parsePasskeyRegistration,
  parsePasskeySignIn,
  passkeyPath,
} from './webauthn.js';

const CREDENTIAL_ID = 'AQIDBAUGBwgJCgsMDQ4PEA';

const REGISTRATION = {
  name: 'the phone in my pocket',
  credential: {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: 'public-key',
    response: {
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
      attestationObject: 'o2NmbXRkbm9uZQ',
      transports: ['internal', 'hybrid'],
    },
  },
};

const ASSERTION = {
  step: 'assertion',
  assertion: {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: 'public-key',
    response: {
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ',
      signature: 'MEUCIQDxyz',
      userHandle: 'YWNjb3VudDo3ZjNh',
    },
  },
};

const problems = (parsed: { ok: boolean; problems?: readonly { path: string; code: string }[] }) =>
  (parsed.problems ?? []).map((problem) => problem.path);

describe('where a passkey lives and what the parameters of one are', () => {
  test('the paths are the one resource and the options a ceremony starts from', () => {
    expect(PASSKEY_PATH).toBe('/api/v1/passkeys');
    expect(PASSKEY_OPTIONS_PATH).toBe('/api/v1/passkeys/options');
    expect(passkeyPath(CREDENTIAL_ID)).toBe(`/api/v1/passkeys/${CREDENTIAL_ID}`);
  });

  test('a credential identifier is escaped on its way into a path, because a browser chose it', () => {
    expect(passkeyPath('a/b?c')).toBe('/api/v1/passkeys/a%2Fb%3Fc');
  });

  test('the relying party is the product, and a ceremony is over in two minutes', () => {
    expect(RELYING_PARTY_NAME).toBe('HolyDeck');
    expect(CHALLENGE_SECONDS).toBe(120);
  });

  test('the transports named are the ones a browser reports, cross-device among them', () => {
    expect(TRANSPORTS).toEqual(['internal', 'hybrid', 'usb', 'nfc', 'ble']);
  });

  test('a label is short enough to read in a list and an account keeps a bounded number of them', () => {
    expect(PASSKEY_LABEL).toEqual({ minimum: 1, maximum: 64 });
    expect(PASSKEY_LIMIT).toBe(20);
    expect(CEREMONY_FIELD.maximum).toBeGreaterThan(1024);
  });
});

describe('registering a passkey, as a body that arrived from a browser', () => {
  test('reads the credential a ceremony produced, with the name the person gave it', () => {
    const parsed = parsePasskeyRegistration(REGISTRATION);
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'the phone in my pocket',
        credential: {
          id: CREDENTIAL_ID,
          rawId: CREDENTIAL_ID,
          type: 'public-key',
          clientDataJSON: REGISTRATION.credential.response.clientDataJSON,
          attestationObject: REGISTRATION.credential.response.attestationObject,
          transports: ['internal', 'hybrid'],
        },
      },
    });
  });

  test('a registration that reports no transports is still a registration', () => {
    const without = { ...REGISTRATION, credential: { ...REGISTRATION.credential, response: { ...REGISTRATION.credential.response, transports: undefined } } };
    const parsed = parsePasskeyRegistration(without);
    expect(parsed.ok && parsed.value.credential.transports).toEqual([]);
  });

  test('a transport this server has never heard of is dropped rather than refused', () => {
    const strange = { ...REGISTRATION, credential: { ...REGISTRATION.credential, response: { ...REGISTRATION.credential.response, transports: ['internal', 'smoke-signal'] } } };
    const parsed = parsePasskeyRegistration(strange);
    expect(parsed.ok && parsed.value.credential.transports).toEqual(['internal']);
  });

  test('a name nobody typed is refused, and so is one longer than a list can show', () => {
    expect(problems(parsePasskeyRegistration({ ...REGISTRATION, name: '' }))).toEqual(['passkey.name']);
    expect(problems(parsePasskeyRegistration({ ...REGISTRATION, name: 'x'.repeat(65) }))).toEqual(['passkey.name']);
  });

  test('a name is kept as it was typed apart from the spacing around it', () => {
    const parsed = parsePasskeyRegistration({ ...REGISTRATION, name: '  the key on my desk  ' });
    expect(parsed.ok && parsed.value.name).toBe('the key on my desk');
  });

  test('a ceremony field that is not base64url is refused, whichever field it is', () => {
    const broken = { ...REGISTRATION, credential: { ...REGISTRATION.credential, response: { ...REGISTRATION.credential.response, attestationObject: 'not base64url!' } } };
    expect(problems(parsePasskeyRegistration(broken))).toEqual(['passkey.credential.response.attestationObject']);
  });

  test('a ceremony field longer than the ceiling is refused before anything decodes it', () => {
    const huge = { ...REGISTRATION, credential: { ...REGISTRATION.credential, response: { ...REGISTRATION.credential.response, attestationObject: 'A'.repeat(CEREMONY_FIELD.maximum + 1) } } };
    expect(problems(parsePasskeyRegistration(huge))).toEqual(['passkey.credential.response.attestationObject']);
  });

  test('a credential that is not a public key is refused, because nothing else is one', () => {
    const other = { ...REGISTRATION, credential: { ...REGISTRATION.credential, type: 'password' } };
    expect(problems(parsePasskeyRegistration(other))).toEqual(['passkey.credential.type']);
  });

  test('a credential missing the fields a ceremony fills in is refused for each one it is missing', () => {
    const bare = { ...REGISTRATION, credential: { type: 'public-key' } };
    expect(problems(parsePasskeyRegistration(bare))).toEqual([
      'passkey.credential.id',
      'passkey.credential.rawId',
      'passkey.credential.response',
    ]);
  });

  test('a transport reported as something other than text is refused rather than dropped', () => {
    const numbered = { ...REGISTRATION, credential: { ...REGISTRATION.credential, response: { ...REGISTRATION.credential.response, transports: [7] } } };
    expect(problems(parsePasskeyRegistration(numbered))).toEqual(['passkey.credential.response.transports.0']);
  });

  test('a body that is not an object at all is refused as the object it is not', () => {
    expect(problems(parsePasskeyRegistration('a passkey'))).toEqual(['passkey']);
    expect(problems(parsePasskeyRegistration({ name: 'mine' }))).toEqual(['passkey.credential']);
  });
});

describe('naming a passkey that is already registered', () => {
  test('reads the new name, trimmed the way registering one does', () => {
    expect(parsePasskeyName({ name: '  the spare  ' })).toEqual({ ok: true, value: { name: 'the spare' } });
  });

  test('refuses an empty name and one over the label bound', () => {
    expect(problems(parsePasskeyName({ name: '   ' }))).toEqual(['passkey.name']);
    expect(problems(parsePasskeyName({ name: 'x'.repeat(65) }))).toEqual(['passkey.name']);
  });
});

describe('signing in with a passkey, at the path a password signs in through', () => {
  test('a body carrying a passkey is told apart from a password body before either is read', () => {
    expect(isPasskeySignIn({ passkey: { step: 'challenge' } })).toBe(true);
    expect(isPasskeySignIn({ name: 'lucia', password: 'a passphrase nobody guessed' })).toBe(false);
    expect(isPasskeySignIn('a sign-in')).toBe(false);
    expect(isPasskeySignIn(null)).toBe(false);
  });

  test('the first step asks for a challenge and carries nothing else, because it names nobody', () => {
    expect(parsePasskeySignIn({ passkey: { step: 'challenge' } })).toEqual({ ok: true, value: { step: 'challenge' } });
  });

  test('a challenge request that carries an assertion anyway is refused rather than half-read', () => {
    expect(problems(parsePasskeySignIn({ passkey: { step: 'challenge', assertion: ASSERTION.assertion } }))).toEqual([
      'passkey.assertion',
    ]);
  });

  test('the second step carries the assertion the authenticator signed', () => {
    const parsed = parsePasskeySignIn({ passkey: ASSERTION });
    expect(parsed).toEqual({
      ok: true,
      value: {
        step: 'assertion',
        assertion: {
          id: CREDENTIAL_ID,
          rawId: CREDENTIAL_ID,
          type: 'public-key',
          clientDataJSON: ASSERTION.assertion.response.clientDataJSON,
          authenticatorData: ASSERTION.assertion.response.authenticatorData,
          signature: ASSERTION.assertion.response.signature,
          userHandle: ASSERTION.assertion.response.userHandle,
        },
      },
    });
  });

  test('an assertion from an authenticator that returned no user handle is still an assertion', () => {
    const without = { step: 'assertion', assertion: { ...ASSERTION.assertion, response: { ...ASSERTION.assertion.response, userHandle: undefined } } };
    const parsed = parsePasskeySignIn({ passkey: without });
    expect(parsed.ok && parsed.value.step === 'assertion' && parsed.value.assertion.userHandle).toBeUndefined();
  });

  test('an assertion step with no assertion is refused, and so is a step nobody offers', () => {
    expect(problems(parsePasskeySignIn({ passkey: { step: 'assertion' } }))).toEqual(['passkey.assertion']);
    expect(problems(parsePasskeySignIn({ passkey: { step: 'recovery' } }))).toEqual(['passkey.step']);
  });

  test('a signature that is not base64url is refused before anything verifies it', () => {
    const broken = { step: 'assertion', assertion: { ...ASSERTION.assertion, response: { ...ASSERTION.assertion.response, signature: '!' } } };
    expect(problems(parsePasskeySignIn({ passkey: broken }))).toEqual(['passkey.assertion.response.signature']);
  });

  test('a body with no passkey in it at all is refused under the field it is missing', () => {
    expect(problems(parsePasskeySignIn({ name: 'lucia' }))).toEqual(['passkey']);
    expect(problems(parsePasskeySignIn('a passkey'))).toEqual(['passkey']);
  });
});
