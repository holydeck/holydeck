// The browser half of passkeys: what this device can actually do, which transports may be offered
// because of it, and the two ceremonies. Nothing here throws. A passkey is a second way in and never
// the only one, so every refusal is a value the caller can show beside a password form that still
// works, and every question asked of the browser survives the browser not being able to answer it.

/** The statics that answer capability questions. Every one of them is missing in some shipping browser. */
export interface PublicKeyCredentialStaticsLike {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Readonly<Record<string, boolean | undefined>>>;
}

export interface AuthenticatorAttestationResponseLike {
  readonly clientDataJSON: ArrayBuffer;
  readonly attestationObject: ArrayBuffer;
  getTransports?: () => readonly string[];
}

export interface AuthenticatorAssertionResponseLike {
  readonly clientDataJSON: ArrayBuffer;
  readonly authenticatorData: ArrayBuffer;
  readonly signature: ArrayBuffer;
  readonly userHandle: ArrayBuffer | null;
}

interface CredentialLike {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  getClientExtensionResults?: () => Readonly<Record<string, unknown>>;
}

export interface AttestationCredentialLike extends CredentialLike {
  readonly response: AuthenticatorAttestationResponseLike;
}

export interface AssertionCredentialLike extends CredentialLike {
  readonly response: AuthenticatorAssertionResponseLike;
}

/**
 * The browser reads far more of the ceremony request than this module names — the relying party, the
 * algorithms it will accept, the timeout — so the request travels as the server wrote it, with only
 * the fields that have to become buffers replaced.
 */
export interface CeremonyRequest {
  readonly publicKey: Record<string, unknown>;
}

export interface CredentialsContainerLike {
  create(request: CeremonyRequest): Promise<AttestationCredentialLike | null>;
  get(request: CeremonyRequest): Promise<AssertionCredentialLike | null>;
}

/** The two halves of WebAuthn this client touches, injected so a test can stand in for a browser. */
export interface WebAuthnLike {
  readonly publicKeyCredential?: PublicKeyCredentialStaticsLike;
  readonly credentials?: CredentialsContainerLike;
}

/** The transports this client offers a person, spelled the way WebAuthn and the server spell them. */
export type PasskeyTransport = 'internal' | 'hybrid';

export interface PasskeyCapabilities {
  readonly supported: boolean;
  readonly platformAuthenticator: boolean;
  readonly crossDevice: boolean;
}

/** Said by the client, never by the server: this browser has no passkeys to offer. */
export const PASSKEY_UNAVAILABLE = 'client.passkey_unavailable';

/** Said by the client when a person dismissed the prompt, which is not a failure and not a refusal. */
export const PASSKEY_CANCELLED = 'client.passkey_cancelled';

/** Said by the client when the ceremony ran and did not produce a credential it can send. */
export const PASSKEY_FAILED = 'client.passkey_failed';

export type PasskeyProblem = typeof PASSKEY_UNAVAILABLE | typeof PASSKEY_CANCELLED | typeof PASSKEY_FAILED;

export type PasskeyRefused = {
  readonly ok: false;
  readonly code: PasskeyProblem;
  readonly message: string;
};

export type PasskeyDone<T> = {
  readonly ok: true;
  readonly credential: T;
};

export type PasskeyResult<T> = PasskeyDone<T> | PasskeyRefused;

/** A credential the server already knows about, as it sends it: an identifier in base64url. */
export type PasskeyDescriptor = {
  readonly id: string;
  readonly type?: string;
  readonly transports?: readonly string[];
};

export type PasskeyUser = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
};

export type RegistrationOptions = {
  readonly challenge: string;
  readonly user: PasskeyUser;
  readonly excludeCredentials?: readonly PasskeyDescriptor[];
};

export type AssertionOptions = {
  readonly challenge: string;
  readonly allowCredentials?: readonly PasskeyDescriptor[];
};

export type RegisteredPasskey = {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports: readonly string[];
  };
};

export type AssertedPasskey = {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
};

// Base64url is what travels and buffers are what the browser takes, and the two conversions are short
// enough that writing them here costs less than a dependency a browser-safe workspace may not have.
// The padding a server left off has to go back on before `atob` will read the text at all.
const fromBase64url = (text: string): ArrayBuffer => {
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

const toBase64url = (buffer: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const asBuffers = (descriptors: readonly PasskeyDescriptor[] = []): readonly Record<string, unknown>[] =>
  descriptors.map((descriptor) => ({ ...descriptor, id: fromBase64url(descriptor.id) }));

/**
 * The container, but only where the rest of WebAuthn is there too. A browser can ship the credential
 * manager without the passkey part of it, and a ceremony started against that one fails in the middle
 * rather than saying up front that this device was never going to work.
 */
const ceremoniesOf = (browser: WebAuthnLike): CredentialsContainerLike | undefined =>
  browser.publicKeyCredential === undefined ? undefined : browser.credentials;

/** A capability question a browser cannot answer, or refuses to, is a no; it is never a maybe. */
const answered = async (question: () => Promise<boolean> | undefined): Promise<boolean> => {
  try {
    return (await question()) === true;
  } catch {
    return false;
  }
};

/**
 * Cross-device is decided from `getClientCapabilities()` first, because it is the only question whose
 * answer is about the thing being asked: `hybridTransport` says this browser can drive a phone over
 * the hybrid transport. Where the report is missing — it is the newest of the three — conditional
 * mediation stands in for it, not because the two mean the same thing, but because a browser that has
 * the platform credential picker is the one that has the cross-device entry inside it. A browser with
 * neither question is read as having no cross-device transport, so it is never offered one.
 */
const crossDeviceIn = async (statics: PublicKeyCredentialStaticsLike): Promise<boolean> => {
  let report: Readonly<Record<string, boolean | undefined>> | undefined;
  try {
    report = await statics.getClientCapabilities?.();
  } catch {
    report = undefined;
  }
  if (report !== undefined) return report['hybridTransport'] === true;
  return answered(() => statics.isConditionalMediationAvailable?.());
};

export async function passkeyCapabilities(browser: WebAuthnLike): Promise<PasskeyCapabilities> {
  const statics = browser.publicKeyCredential;
  if (statics === undefined || ceremoniesOf(browser) === undefined) {
    return { supported: false, platformAuthenticator: false, crossDevice: false };
  }
  const [platformAuthenticator, crossDevice] = await Promise.all([
    answered(() => statics.isUserVerifyingPlatformAuthenticatorAvailable?.()),
    crossDeviceIn(statics),
  ]);
  return { supported: true, platformAuthenticator, crossDevice };
}

/** Which transports a person may be shown. Offering one the browser cannot drive is a dead end. */
export function offeredTransports(capabilities: PasskeyCapabilities): readonly PasskeyTransport[] {
  if (!capabilities.supported) return [];
  const offered: PasskeyTransport[] = [];
  if (capabilities.platformAuthenticator) offered.push('internal');
  if (capabilities.crossDevice) offered.push('hybrid');
  return offered;
}

const unavailable = (): PasskeyRefused => ({
  ok: false,
  code: PASSKEY_UNAVAILABLE,
  message: 'this browser cannot use passkeys',
});

const failed = (message: string): PasskeyRefused => ({ ok: false, code: PASSKEY_FAILED, message });

/**
 * `NotAllowedError` is the one name that means the person was asked and the site was told nothing more:
 * a dismissed prompt and a prompt that timed out are deliberately indistinguishable, so both are read
 * as cancelled. The message is kept for a log, never for the screen — the sentence a person reads is
 * chosen from the code, which is this client's own word and carries nothing the server said, so a
 * refusal reads the same whether or not the account behind the attempt exists.
 */
const refusedBy = (error: unknown): PasskeyRefused => {
  const message = error instanceof Error ? error.message : String(error);
  const cancelled = error instanceof Error && error.name === 'NotAllowedError';
  return { ok: false, code: cancelled ? PASSKEY_CANCELLED : PASSKEY_FAILED, message };
};

const identity = (credential: CredentialLike) => ({
  id: credential.id,
  rawId: toBase64url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
});

export async function startRegistration(
  browser: WebAuthnLike,
  options: RegistrationOptions,
): Promise<PasskeyResult<RegisteredPasskey>> {
  const ceremonies = ceremoniesOf(browser);
  if (ceremonies === undefined) return unavailable();

  const publicKey = {
    ...options,
    challenge: fromBase64url(options.challenge),
    user: { ...options.user, id: fromBase64url(options.user.id) },
    excludeCredentials: asBuffers(options.excludeCredentials),
  };

  try {
    const credential = await ceremonies.create({ publicKey });
    // The specification lets a browser resolve with nothing. That is not a credential to send.
    if (credential === null) return failed('the browser produced no credential');
    return {
      ok: true,
      credential: {
        ...identity(credential),
        response: {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          attestationObject: toBase64url(credential.response.attestationObject),
          // Sent so the server can record how this passkey travels, which is what lets a later sign-in
          // offer the cross-device option for it rather than guess at one.
          transports: credential.response.getTransports?.() ?? [],
        },
      },
    };
  } catch (error) {
    return refusedBy(error);
  }
}

export async function startAssertion(
  browser: WebAuthnLike,
  options: AssertionOptions,
): Promise<PasskeyResult<AssertedPasskey>> {
  const ceremonies = ceremoniesOf(browser);
  if (ceremonies === undefined) return unavailable();

  const publicKey = {
    ...options,
    challenge: fromBase64url(options.challenge),
    allowCredentials: asBuffers(options.allowCredentials),
  };

  try {
    const credential = await ceremonies.get({ publicKey });
    if (credential === null) return failed('the browser produced no assertion');
    const { userHandle } = credential.response;
    return {
      ok: true,
      credential: {
        ...identity(credential),
        response: {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          authenticatorData: toBase64url(credential.response.authenticatorData),
          signature: toBase64url(credential.response.signature),
          // An authenticator that named no user leaves the field out entirely, rather than sending an
          // empty one the server would have to decide the meaning of.
          ...(userHandle === null ? {} : { userHandle: toBase64url(userHandle) }),
        },
      },
    };
  } catch (error) {
    return refusedBy(error);
  }
}
