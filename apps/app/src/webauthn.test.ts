import { CHALLENGE_SECONDS, RELYING_PARTY_NAME, TRANSPORTS } from '@holydeck/contracts/webauthn';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  authenticationOptions,
  challengeIn,
  registrationOptions,
  verifiedAssertion,
  verifiedRegistration,
} from './webauthn.js';
import { webauthnDevice } from '../test/helpers/webauthn-device.js';

import type { PasskeyAssertion, PasskeyTransport, RegistrationCredential } from '@holydeck/contracts/webauthn';

import type { RelyingParty, StoredCredential } from './webauthn.js';
import type { AuthenticateOptions, RegisterOptions, WebAuthnDevice } from '../test/helpers/webauthn-device.js';

const PARTY: RelyingParty = { id: 'holydeck.example', origin: 'https://holydeck.example' };

const ELSEWHERE = 'https://passkeys.example';

const ACCOUNT = { id: '7f3aQmVhdGl0dWRlc19hcmU', name: 'ada@example.test', displayName: 'Ada Lovelace' };

const CHALLENGE = 'Y2hhbGxlbmdlLWZvci10aGUtdGVzdA';

const OTHER_CHALLENGE = 'YW5vdGhlci1jaGFsbGVuZ2UtZW50aXJlbHk';

let device: WebAuthnDevice;

beforeEach(() => {
  device = webauthnDevice({ rpId: PARTY.id, origin: PARTY.origin });
});

/** What the contract's parser hands a route: the browser's nested response, already flattened. */
const registration = (options?: RegisterOptions): RegistrationCredential => {
  const produced = device.register(CHALLENGE, options);
  return {
    id: produced.id,
    rawId: produced.rawId,
    type: 'public-key',
    clientDataJSON: produced.response.clientDataJSON,
    attestationObject: produced.response.attestationObject,
    transports: TRANSPORTS.filter((transport) => produced.response.transports?.includes(transport) === true),
  };
};

const assertion = (options?: AuthenticateOptions): PasskeyAssertion => {
  const produced = device.authenticate(CHALLENGE, options);
  return {
    id: produced.id,
    rawId: produced.rawId,
    type: 'public-key',
    clientDataJSON: produced.response.clientDataJSON,
    authenticatorData: produced.response.authenticatorData,
    signature: produced.response.signature,
    userHandle: produced.response.userHandle,
  };
};

const stored = async (): Promise<StoredCredential> => {
  const verified = await verifiedRegistration({ party: PARTY, challenge: CHALLENGE, response: registration() });
  if (!verified.ok) throw new Error(`the registration was refused: ${verified.reason}`);
  return verified.value;
};

const refusedRegistration = async (response: RegistrationCredential, challenge = CHALLENGE): Promise<string> => {
  const verified = await verifiedRegistration({ party: PARTY, challenge, response });
  if (verified.ok) throw new Error('the registration was accepted');
  return verified.reason;
};

const refusedAssertion = async (
  response: PasskeyAssertion,
  credential: StoredCredential,
  challenge = CHALLENGE,
): Promise<string> => {
  const verified = await verifiedAssertion({ party: PARTY, challenge, response, credential });
  if (verified.ok) throw new Error('the assertion was accepted');
  return verified.reason;
};

const clientDataOf = (challenge: unknown): string =>
  Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: PARTY.origin }), 'utf8').toString('base64url');

describe('the options a registration ceremony starts with', () => {
  test('publishes the challenge the caller drew, unchanged, so the same text verifies the answer', async () => {
    const options = await registrationOptions({ party: PARTY, account: ACCOUNT, existing: [], challenge: CHALLENGE });
    expect(options.challenge).toBe(CHALLENGE);
    expect(options.timeout).toBe(CHALLENGE_SECONDS * 1000);
  });

  test('names the relying party, and asks for a key the device keeps and a person it verified', async () => {
    const options = await registrationOptions({ party: PARTY, account: ACCOUNT, existing: [], challenge: CHALLENGE });
    expect(options.rp).toEqual({ name: RELYING_PARTY_NAME, id: PARTY.id });
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection?.residentKey).toBe('required');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
  });

  test('carries the account as the bytes an authenticator hands back again as a user handle', async () => {
    const options = await registrationOptions({ party: PARTY, account: ACCOUNT, existing: [], challenge: CHALLENGE });
    expect(options.user).toEqual({
      id: Buffer.from(ACCOUNT.id, 'utf8').toString('base64url'),
      name: ACCOUNT.name,
      displayName: ACCOUNT.displayName,
    });
  });

  test('lists the keys the account already has, so one authenticator is not registered twice', async () => {
    const existing = await stored();
    const options = await registrationOptions({ party: PARTY, account: ACCOUNT, existing: [existing], challenge: CHALLENGE });
    expect(options.excludeCredentials).toEqual([
      { id: existing.id, type: 'public-key', transports: ['internal'] },
    ]);
  });
});

describe('the options an assertion ceremony starts with', () => {
  test('publishes the challenge unchanged, and will not take a person who was merely present', async () => {
    const options = await authenticationOptions({ party: PARTY, challenge: CHALLENGE });
    expect(options.challenge).toBe(CHALLENGE);
    expect(options.rpId).toBe(PARTY.id);
    expect(options.timeout).toBe(CHALLENGE_SECONDS * 1000);
    expect(options.userVerification).toBe('required');
  });

  test('says nothing about which key, because the one to use is the one the browser already holds', async () => {
    const options = await authenticationOptions({ party: PARTY, challenge: CHALLENGE });
    expect(options.allowCredentials).toBeUndefined();
  });
});

describe('verifying a registration', () => {
  test('says what a store should keep: the credential, its key, its counter and how it is reached', async () => {
    const credential = await stored();
    expect(credential.id).toBe(device.credentialId);
    expect(credential.publicKey).toBe(Buffer.from(device.publicKey).toString('base64url'));
    expect(credential.counter).toBe(0);
    expect(credential.transports).toEqual(['internal']);
  });

  test('says whether the key is backed up, which is what makes losing the device survivable', async () => {
    const verified = await verifiedRegistration({ party: PARTY, challenge: CHALLENGE, response: registration() });
    expect(verified).toMatchObject({ ok: true, value: { synced: false } });
  });

  test('keeps the transports a browser reported in the vocabulary’s own order rather than its own', async () => {
    const response: RegistrationCredential = { ...registration(), transports: ['usb', 'internal'] };
    const verified = await verifiedRegistration({ party: PARTY, challenge: CHALLENGE, response });
    expect(verified).toMatchObject({ ok: true, value: { transports: ['internal', 'usb'] } });
  });

  test('refuses one answered from an origin that is not ours, and says so rather than raising', async () => {
    const reason = await refusedRegistration(registration({ origin: ELSEWHERE }));
    expect(reason).toContain(ELSEWHERE);
  });

  test('refuses one made for a relying party that is not ours', async () => {
    const reason = await refusedRegistration(registration({ rpId: 'passkeys.example' }));
    expect(reason).toBe('Unexpected RP ID hash');
  });

  test('refuses one where somebody was present but nobody was verified', async () => {
    const reason = await refusedRegistration(registration({ userVerified: false }));
    expect(reason).toContain('could not be verified');
  });

  test('refuses one answering a challenge other than the one that was issued', async () => {
    const reason = await refusedRegistration(registration(), OTHER_CHALLENGE);
    expect(reason).toContain(OTHER_CHALLENGE);
  });

  test('says what a throw that was not an Error was, because the reason still has to read', async () => {
    const response: RegistrationCredential = {
      ...registration(),
      get transports(): readonly PasskeyTransport[] {
        throw 'the runtime threw something that was not an Error';
      },
    };
    expect(await refusedRegistration(response)).toBe('the runtime threw something that was not an Error');
  });
});

describe('verifying an assertion', () => {
  test('accepts one signed by the key the registration stored, and reports the counter it came with', async () => {
    const credential = await stored();
    const verified = await verifiedAssertion({
      party: PARTY,
      challenge: CHALLENGE,
      response: assertion({ userHandle: ACCOUNT.id }),
      credential,
    });
    expect(verified).toEqual({ ok: true, value: { counter: 1 } });
  });

  test('refuses one whose signature does not check out, which is the one refusal the library returns', async () => {
    const credential = await stored();
    expect(await refusedAssertion(assertion({ wrongSignature: true }), credential)).toBe(
      'the ceremony did not verify',
    );
  });

  test('refuses one answered from an origin that is not ours', async () => {
    const credential = await stored();
    expect(await refusedAssertion(assertion({ origin: ELSEWHERE }), credential)).toContain(ELSEWHERE);
  });

  test('refuses one made for a relying party that is not ours', async () => {
    const credential = await stored();
    expect(await refusedAssertion(assertion({ rpId: 'passkeys.example' }), credential)).toBe('Unexpected RP ID hash');
  });

  test('refuses one where nobody was verified, however present they were', async () => {
    const credential = await stored();
    expect(await refusedAssertion(assertion({ userVerified: false }), credential)).toContain('could not be verified');
  });

  test('refuses one answering a challenge other than the one that was issued', async () => {
    const credential = await stored();
    expect(await refusedAssertion(assertion(), credential, OTHER_CHALLENGE)).toContain(OTHER_CHALLENGE);
  });

  test('refuses one whose counter has gone backwards, which is a credential somebody copied', async () => {
    const credential = { ...(await stored()), counter: 5 };
    expect(await refusedAssertion(assertion({ signCount: 3 }), credential)).toBe(
      'Response counter value 3 was lower than expected 5',
    );
  });

  test('accepts a counter frozen at zero, which is the only counter a passkey ever reports', async () => {
    const credential = await stored();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verified = await verifiedAssertion({
        party: PARTY,
        challenge: CHALLENGE,
        response: assertion({ signCount: 0 }),
        credential,
      });
      expect(verified).toEqual({ ok: true, value: { counter: 0 } });
    }
  });
});

describe('reading the challenge a response answered', () => {
  test('finds the challenge in the client data, which is how the stored one is looked up', () => {
    expect(challengeIn(clientDataOf(CHALLENGE))).toBe(CHALLENGE);
  });

  test('answers with nothing for client data that is not base64url of anything', () => {
    expect(challengeIn('not base64url at all')).toBeUndefined();
  });

  test('answers with nothing for client data that is not JSON', () => {
    expect(challengeIn(Buffer.from('{ not json', 'utf8').toString('base64url'))).toBeUndefined();
  });

  test('answers with nothing for JSON that is not an object, and for one that is a list', () => {
    expect(challengeIn(Buffer.from('42', 'utf8').toString('base64url'))).toBeUndefined();
    expect(challengeIn(Buffer.from('null', 'utf8').toString('base64url'))).toBeUndefined();
    expect(challengeIn(Buffer.from('["a"]', 'utf8').toString('base64url'))).toBeUndefined();
  });

  test('answers with nothing when the challenge is missing, is not text, or is empty', () => {
    expect(challengeIn(Buffer.from('{"type":"webauthn.get"}', 'utf8').toString('base64url'))).toBeUndefined();
    expect(challengeIn(clientDataOf(7))).toBeUndefined();
    expect(challengeIn(clientDataOf(''))).toBeUndefined();
  });
});
