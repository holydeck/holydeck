import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  PASSKEY_CANCELLED,
  PASSKEY_FAILED,
  PASSKEY_UNAVAILABLE,
  type AssertionCredentialLike,
  type AttestationCredentialLike,
  type CredentialsContainerLike,
  type PasskeyCapabilities,
  type PublicKeyCredentialStaticsLike,
  type WebAuthnLike,
  offeredTransports,
  passkeyCapabilities,
  startAssertion,
  startRegistration,
} from './passkey.js';

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

const encoded = (...values: number[]): string => Buffer.from(values).toString('base64url');

const decoded = (value: unknown): number[] => {
  if (!(value instanceof ArrayBuffer)) throw new Error('the browser was handed something that is not a buffer');
  return [...new Uint8Array(value)];
};

const fields = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) throw new Error('the browser was handed something that is not an object');
  return Object.fromEntries(Object.entries(value));
};

const listed = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('the browser was handed something that is not a list');
  return value;
};

const credentialsThat = (answers: Partial<CredentialsContainerLike>): CredentialsContainerLike => ({
  create: vi.fn(async () => {
    throw new Error('no registration was expected');
  }),
  get: vi.fn(async () => {
    throw new Error('no assertion was expected');
  }),
  ...answers,
});

/** A browser that can run a ceremony, so a capability test only varies the questions it can answer. */
const asked = (publicKeyCredential: PublicKeyCredentialStaticsLike): WebAuthnLike => ({
  publicKeyCredential,
  credentials: credentialsThat({}),
});

const recording = <T>(credential: T) => {
  const seen: { publicKey: Record<string, unknown> } = { publicKey: {} };
  const ceremony = vi.fn(async (request: { publicKey: Record<string, unknown> }) => {
    seen.publicKey = request.publicKey;
    return credential;
  });
  return { seen, ceremony };
};

const registrationOptions = {
  challenge: encoded(1, 2, 3),
  rp: { id: 'holydeck.example', name: 'HolyDeck' },
  user: { id: encoded(9, 9), name: 'grace', displayName: 'Grace Hopper' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
  excludeCredentials: [{ id: encoded(7, 8), type: 'public-key', transports: ['internal'] }],
};

const assertionOptions = {
  challenge: encoded(1, 2, 3),
  rpId: 'holydeck.example',
  allowCredentials: [{ id: encoded(7, 8), type: 'public-key' }],
};

const attestation = (response: Partial<AttestationCredentialLike['response']> = {}): AttestationCredentialLike => ({
  id: encoded(99, 114, 101, 100),
  rawId: bytes(99, 114, 101, 100),
  type: 'public-key',
  getClientExtensionResults: () => ({ credProps: { rk: true } }),
  response: {
    clientDataJSON: bytes(1, 2, 3),
    attestationObject: bytes(4, 5),
    getTransports: () => ['internal', 'hybrid'],
    ...response,
  },
});

const assertion = (response: Partial<AssertionCredentialLike['response']> = {}): AssertionCredentialLike => ({
  id: encoded(99, 114, 101, 100),
  rawId: bytes(99, 114, 101, 100),
  type: 'public-key',
  getClientExtensionResults: () => ({}),
  response: {
    clientDataJSON: bytes(1, 2, 3),
    authenticatorData: bytes(6, 7),
    signature: bytes(8, 9, 10),
    userHandle: bytes(9, 9),
    ...response,
  },
});

const dismissed = (): Error => Object.assign(new Error('The operation either timed out or was not allowed.'), {
  name: 'NotAllowedError',
});

describe('asking a browser what it can do with passkeys', () => {
  it('says passkeys are unsupported where the browser has no WebAuthn at all', async () => {
    expect(await passkeyCapabilities({ credentials: credentialsThat({}) })).toEqual({
      supported: false,
      platformAuthenticator: false,
      crossDevice: false,
    });
  });

  it('says passkeys are unsupported where the browser answers questions but runs no ceremony', async () => {
    expect(await passkeyCapabilities({ publicKeyCredential: {} })).toEqual({
      supported: false,
      platformAuthenticator: false,
      crossDevice: false,
    });
  });

  it('reports the platform authenticator the browser says this device has', async () => {
    const capabilities = await passkeyCapabilities(
      asked({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true }),
    );

    expect(capabilities).toEqual({ supported: true, platformAuthenticator: true, crossDevice: false });
  });

  it('reports no platform authenticator when that is a question this browser cannot answer', async () => {
    expect(await passkeyCapabilities(asked({}))).toEqual({
      supported: true,
      platformAuthenticator: false,
      crossDevice: false,
    });
  });

  it('reports no platform authenticator when asking rejects, because a refusal is not a yes', async () => {
    const capabilities = await passkeyCapabilities(
      asked({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => {
          throw new Error('not allowed in this context');
        },
      }),
    );

    expect(capabilities.platformAuthenticator).toBe(false);
  });

  it('reads cross-device support out of the client capability report where the browser publishes one', async () => {
    const isConditionalMediationAvailable = vi.fn(async () => false);
    const capabilities = await passkeyCapabilities(
      asked({
        getClientCapabilities: async () => ({ hybridTransport: true, passkeyPlatformAuthenticator: true }),
        isConditionalMediationAvailable,
      }),
    );

    expect(capabilities.crossDevice).toBe(true);
    expect(isConditionalMediationAvailable).not.toHaveBeenCalled();
  });

  it('believes a capability report that says there is no hybrid transport over the older hint', async () => {
    const isConditionalMediationAvailable = vi.fn(async () => true);
    const capabilities = await passkeyCapabilities(
      asked({ getClientCapabilities: async () => ({ hybridTransport: false }), isConditionalMediationAvailable }),
    );

    expect(capabilities.crossDevice).toBe(false);
    expect(isConditionalMediationAvailable).not.toHaveBeenCalled();
  });

  it('falls back to conditional mediation where the browser publishes no capability report', async () => {
    const capabilities = await passkeyCapabilities(
      asked({ isConditionalMediationAvailable: async () => true }),
    );

    expect(capabilities.crossDevice).toBe(true);
  });

  it('falls back to conditional mediation when asking for the capability report rejects', async () => {
    const capabilities = await passkeyCapabilities(
      asked({
        getClientCapabilities: async () => {
          throw new Error('not implemented');
        },
        isConditionalMediationAvailable: async () => true,
      }),
    );

    expect(capabilities.crossDevice).toBe(true);
  });

  it('offers no cross-device transport when the browser cannot report whether it has one', async () => {
    const capabilities = await passkeyCapabilities(
      asked({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true }),
    );

    expect(capabilities.crossDevice).toBe(false);
  });

  it('offers no cross-device transport when conditional mediation is a question that rejects', async () => {
    const capabilities = await passkeyCapabilities(
      asked({
        isConditionalMediationAvailable: async () => {
          throw new Error('not implemented');
        },
      }),
    );

    expect(capabilities.crossDevice).toBe(false);
  });
});

describe('offering transports', () => {
  const capabilities = (platformAuthenticator: boolean, crossDevice: boolean): PasskeyCapabilities => ({
    supported: true,
    platformAuthenticator,
    crossDevice,
  });

  it('offers this device and another device when the browser reports both', () => {
    expect(offeredTransports(capabilities(true, true))).toEqual(['internal', 'hybrid']);
  });

  it('offers only this device when the browser cannot reach another one', () => {
    expect(offeredTransports(capabilities(true, false))).toEqual(['internal']);
  });

  it('offers only another device when this one has no authenticator of its own', () => {
    expect(offeredTransports(capabilities(false, true))).toEqual(['hybrid']);
  });

  it('offers nothing when the browser reports neither', () => {
    expect(offeredTransports(capabilities(false, false))).toEqual([]);
  });

  it('offers nothing at all where WebAuthn is missing, so the password form stays the way in', () => {
    expect(offeredTransports({ supported: false, platformAuthenticator: true, crossDevice: true })).toEqual([]);
  });
});

describe('registering a passkey', () => {
  it('hands the browser the challenge, the user and the excluded credentials as buffers', async () => {
    const { seen, ceremony } = recording(attestation());

    await startRegistration({ publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) }, registrationOptions);

    expect(decoded(seen.publicKey['challenge'])).toEqual([1, 2, 3]);
    expect(decoded(fields(seen.publicKey['user'])['id'])).toEqual([9, 9]);
    expect(fields(seen.publicKey['user'])['name']).toBe('grace');
    expect(decoded(fields(listed(seen.publicKey['excludeCredentials'])[0])['id'])).toEqual([7, 8]);
    expect(fields(listed(seen.publicKey['excludeCredentials'])[0])['transports']).toEqual(['internal']);
    expect(seen.publicKey['rp']).toEqual({ id: 'holydeck.example', name: 'HolyDeck' });
  });

  it('excludes nothing when the server named no credential to exclude', async () => {
    const { seen, ceremony } = recording(attestation());
    const withoutExclusions = { challenge: registrationOptions.challenge, user: registrationOptions.user };

    await startRegistration({ publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) }, withoutExclusions);

    expect(seen.publicKey['excludeCredentials']).toEqual([]);
  });

  it('sends the new credential back as the base64url shape the server reads', async () => {
    const { ceremony } = recording(attestation());

    const result = await startRegistration(
      { publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) },
      registrationOptions,
    );

    expect(result).toEqual({
      ok: true,
      credential: {
        id: encoded(99, 114, 101, 100),
        rawId: encoded(99, 114, 101, 100),
        type: 'public-key',
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: encoded(1, 2, 3),
          attestationObject: encoded(4, 5),
          transports: ['internal', 'hybrid'],
        },
      },
    });
  });

  it('names no transport when the authenticator does not say which ones it speaks', async () => {
    const { ceremony } = recording(attestation({ getTransports: undefined }));

    const result = await startRegistration(
      { publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) },
      registrationOptions,
    );

    expect(result.ok ? result.credential.response.transports : undefined).toEqual([]);
  });

  it('sends empty extension results where the browser reports none', async () => {
    const { ceremony } = recording({ ...attestation(), getClientExtensionResults: undefined });

    const result = await startRegistration(
      { publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) },
      registrationOptions,
    );

    expect(result.ok ? result.credential.clientExtensionResults : undefined).toEqual({});
  });

  it('encodes every byte value, so nothing the authenticator signed is lost on the way back', async () => {
    const every = [...Array(256).keys()];
    const { ceremony } = recording({ ...attestation(), rawId: bytes(...every) });

    const result = await startRegistration(
      { publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) },
      registrationOptions,
    );

    expect(result.ok ? result.credential.rawId : undefined).toBe(encoded(...every));
  });

  it('decodes a challenge of any length, putting back the padding base64url leaves off', async () => {
    for (const challenge of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      const { seen, ceremony } = recording(attestation());

      await startRegistration(
        { publicKeyCredential: {}, credentials: credentialsThat({ create: ceremony }) },
        { ...registrationOptions, challenge: encoded(...challenge) },
      );

      expect(decoded(seen.publicKey['challenge'])).toEqual(challenge);
    }
  });

  it('says passkeys are unavailable rather than throwing where the browser has none', async () => {
    expect(await startRegistration({}, registrationOptions)).toEqual({
      ok: false,
      code: PASSKEY_UNAVAILABLE,
      message: 'this browser cannot use passkeys',
    });
  });

  it('says the ceremony was cancelled when the person dismissed the prompt', async () => {
    const browser = {
      publicKeyCredential: {},
      credentials: credentialsThat({
        create: async () => {
          throw dismissed();
        },
      }),
    };

    const result = await startRegistration(browser, registrationOptions);

    expect(result.ok ? undefined : result.code).toBe(PASSKEY_CANCELLED);
  });

  it('says the ceremony failed when the browser refused it for any other reason', async () => {
    const browser = {
      publicKeyCredential: {},
      credentials: credentialsThat({
        create: async () => {
          throw Object.assign(new Error('a credential is already registered'), { name: 'InvalidStateError' });
        },
      }),
    };

    const result = await startRegistration(browser, registrationOptions);

    expect(result).toEqual({
      ok: false,
      code: PASSKEY_FAILED,
      message: 'a credential is already registered',
    });
  });

  it('says the ceremony failed when the browser produced no credential at all', async () => {
    const browser = { publicKeyCredential: {}, credentials: credentialsThat({ create: async () => null }) };

    const result = await startRegistration(browser, registrationOptions);

    expect(result.ok ? undefined : result.code).toBe(PASSKEY_FAILED);
  });
});

describe('proving a passkey', () => {
  it('hands the browser the challenge and the allowed credentials as buffers', async () => {
    const { seen, ceremony } = recording(assertion());

    await startAssertion({ publicKeyCredential: {}, credentials: credentialsThat({ get: ceremony }) }, assertionOptions);

    expect(decoded(seen.publicKey['challenge'])).toEqual([1, 2, 3]);
    expect(decoded(fields(listed(seen.publicKey['allowCredentials'])[0])['id'])).toEqual([7, 8]);
    expect(seen.publicKey['rpId']).toBe('holydeck.example');
  });

  it('allows any passkey the account has when the server named none', async () => {
    const { seen, ceremony } = recording(assertion());
    const withoutAllowList = { challenge: assertionOptions.challenge, rpId: assertionOptions.rpId };

    await startAssertion({ publicKeyCredential: {}, credentials: credentialsThat({ get: ceremony }) }, withoutAllowList);

    expect(seen.publicKey['allowCredentials']).toEqual([]);
  });

  it('sends the assertion back as the base64url shape the server reads', async () => {
    const { ceremony } = recording(assertion());

    const result = await startAssertion(
      { publicKeyCredential: {}, credentials: credentialsThat({ get: ceremony }) },
      assertionOptions,
    );

    expect(result).toEqual({
      ok: true,
      credential: {
        id: encoded(99, 114, 101, 100),
        rawId: encoded(99, 114, 101, 100),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: encoded(1, 2, 3),
          authenticatorData: encoded(6, 7),
          signature: encoded(8, 9, 10),
          userHandle: encoded(9, 9),
        },
      },
    });
  });

  it('leaves out a user handle the authenticator did not give', async () => {
    const { ceremony } = recording(assertion({ userHandle: null }));

    const result = await startAssertion(
      { publicKeyCredential: {}, credentials: credentialsThat({ get: ceremony }) },
      assertionOptions,
    );

    expect(result.ok && 'userHandle' in result.credential.response).toBe(false);
  });

  it('says passkeys are unavailable rather than throwing, so the password form still works', async () => {
    expect(await startAssertion({ credentials: credentialsThat({}) }, assertionOptions)).toEqual({
      ok: false,
      code: PASSKEY_UNAVAILABLE,
      message: 'this browser cannot use passkeys',
    });
  });

  it('says the assertion was cancelled when the person dismissed the prompt', async () => {
    const browser = {
      publicKeyCredential: {},
      credentials: credentialsThat({
        get: async () => {
          throw dismissed();
        },
      }),
    };

    const result = await startAssertion(browser, assertionOptions);

    expect(result.ok ? undefined : result.code).toBe(PASSKEY_CANCELLED);
  });

  it('says the assertion failed when the browser produced no credential at all', async () => {
    const browser = { publicKeyCredential: {}, credentials: credentialsThat({ get: async () => null }) };

    const result = await startAssertion(browser, assertionOptions);

    expect(result.ok ? undefined : result.code).toBe(PASSKEY_FAILED);
  });

  it('still answers when the ceremony rejected with something that is not an error at all', async () => {
    const browser = {
      publicKeyCredential: {},
      credentials: credentialsThat({
        get: async () => {
          throw 'the authenticator went away';
        },
      }),
    };

    expect(await startAssertion(browser, assertionOptions)).toEqual({
      ok: false,
      code: PASSKEY_FAILED,
      message: 'the authenticator went away',
    });
  });

  it('says why a passkey did not work without saying whether the account exists', async () => {
    const refusals = await Promise.all([
      startAssertion({}, assertionOptions),
      startAssertion(
        {
          publicKeyCredential: {},
          credentials: credentialsThat({
            get: async () => {
              throw dismissed();
            },
          }),
        },
        assertionOptions,
      ),
      startAssertion({ publicKeyCredential: {}, credentials: credentialsThat({ get: async () => null }) }, assertionOptions),
    ]);

    expect(refusals.map((refusal) => (refusal.ok ? '' : refusal.code))).toEqual([
      PASSKEY_UNAVAILABLE,
      PASSKEY_CANCELLED,
      PASSKEY_FAILED,
    ]);
    for (const refusal of refusals) expect(Object.keys(refusal)).toEqual(['ok', 'code', 'message']);
  });
});
