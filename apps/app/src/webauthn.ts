// Where a passkey ceremony is proved, and the only place `@simplewebauthn/server` is reached from.
//
// The checking is not worth a second implementation. It is a signature over a challenge this server
// issued, the hash of the relying party the credential was made for, a flag saying whether anybody was
// actually verified and a counter that is not allowed to go backwards — all of it the standard's, and
// every part of it easy to leave out. So the library does it and this file is the seam it is done
// behind: a store and a route hand over a challenge and a response and are given an answer, and no
// other file imports the library, which is what makes pinning or replacing it a change to one file.
//
// Nothing a browser sent is trusted and nothing here raises over one. The library refuses by throwing
// for everything it can name, and by answering false for the one thing it cannot, which is a signature
// that did not check out; both come back as a refusal carrying its reason in prose, for a log rather
// than for whoever sent the response. What crosses this seam is text — a public key is kept base64url
// the way it arrived, and the bytes it is really made of exist only inside these calls.

import { isRecord } from '@holydeck/contracts/problems';
import { CHALLENGE_SECONDS, RELYING_PARTY_NAME, TRANSPORTS } from '@holydeck/contracts/webauthn';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import type { PasskeyAssertion, PasskeyTransport, RegistrationCredential } from '@holydeck/contracts/webauthn';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

/** Re-exported so a route can name what it is about to send without importing the library itself. */
export type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON };

/** Which deployment a ceremony belongs to: the domain a key is bound to, and the page it is answered on. */
export interface RelyingParty {
  readonly id: string;
  readonly origin: string;
}

/** A registered passkey as this server holds one. The identifier and the key are both base64url text. */
export interface StoredCredential {
  readonly id: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly PasskeyTransport[];
}

export interface RegisteredPasskey extends StoredCredential {
  /** The authenticator's word that this key is backed up, and so outlives the device it was made on. */
  readonly synced: boolean;
}

/** A verification either produced a value or has one reason it did not, in prose for the log. */
export type Verified<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** The account a key is being made for, as the browser will show it and as it comes back afterwards. */
export interface CeremonyAccount {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

const CHALLENGE_MILLISECONDS = CHALLENGE_SECONDS * 1000;

const REFUSED = 'the ceremony did not verify';

/**
 * The challenge as bytes. Handed a string, the library treats it as the text it is and publishes
 * base64url of that text — which is not what the caller drew and stored, and so not what it would later
 * be compared against. Decoding it here is what keeps the challenge that goes out the one that returns.
 */
const challengeBytes = (challenge: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(challenge, 'base64url'));

/**
 * The transports this server makes sense of, in the vocabulary's own order. A browser is free to name
 * one nobody here has heard of, and a hint about how a key is reached again is not worth a refusal.
 */
const knownTransports = (reported: readonly string[]): readonly PasskeyTransport[] =>
  TRANSPORTS.filter((transport) => reported.includes(transport));

/**
 * One answer for both ceremonies. An absence is the library's `verified: false`, which is all it says
 * where there is only one thing it could mean; a throw is everything it can name, and is caught rather
 * than raised because every byte that reaches these calls came from whoever sent the response.
 */
const answered = async <A, B>(
  attempt: () => Promise<A | undefined>,
  into: (verified: A) => B,
): Promise<Verified<B>> => {
  try {
    const verified = await attempt();
    return verified === undefined ? { ok: false, reason: REFUSED } : { ok: true, value: into(verified) };
  } catch (thrown) {
    return { ok: false, reason: thrown instanceof Error ? thrown.message : String(thrown) };
  }
};

/** What a browser is asked for when an account is registering a key it does not have yet. */
export function registrationOptions(input: {
  party: RelyingParty;
  account: CeremonyAccount;
  existing: readonly StoredCredential[];
  challenge: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RELYING_PARTY_NAME,
    rpID: input.party.id,
    // The account identifier goes out as its bytes and comes back as a user handle, which is how an
    // assertion that named no account at all still says whose key answered it.
    userID: Uint8Array.from(Buffer.from(input.account.id, 'utf8')),
    userName: input.account.name,
    userDisplayName: input.account.displayName,
    challenge: challengeBytes(input.challenge),
    timeout: CHALLENGE_MILLISECONDS,
    // No attestation, so no certificate chain to follow and no manufacturer to decide about. What this
    // deployment needs from a key is that it signs, not which factory it came out of.
    attestationType: 'none',
    excludeCredentials: input.existing.map((credential) => ({
      id: credential.id,
      transports: [...credential.transports],
    })),
    // A resident key is what lets somebody sign in without saying who they are first, and a verified
    // user is what makes one factor enough — a key that only proves presence is a password again.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

/**
 * What a browser is asked for when somebody is signing in. Nothing says which key: a resident key is
 * one the browser already knows it holds for this domain, and naming them would say who has an account.
 */
export function authenticationOptions(input: {
  party: RelyingParty;
  challenge: string;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.party.id,
    challenge: challengeBytes(input.challenge),
    timeout: CHALLENGE_MILLISECONDS,
    userVerification: 'required',
  });
}

/** What a store should keep about a key, once the registration that made it has verified. */
export function verifiedRegistration(input: {
  party: RelyingParty;
  challenge: string;
  response: RegistrationCredential;
}): Promise<Verified<RegisteredPasskey>> {
  return answered(
    async () => {
      const outcome = await verifyRegistrationResponse({
        response: {
          id: input.response.id,
          rawId: input.response.rawId,
          type: input.response.type,
          clientExtensionResults: {},
          response: {
            clientDataJSON: input.response.clientDataJSON,
            attestationObject: input.response.attestationObject,
            transports: [...input.response.transports],
          },
        },
        expectedChallenge: input.challenge,
        expectedOrigin: input.party.origin,
        expectedRPID: input.party.id,
        requireUserVerification: true,
      });
      return outcome.registrationInfo;
    },
    (registration) => ({
      id: registration.credential.id,
      publicKey: Buffer.from(registration.credential.publicKey).toString('base64url'),
      counter: registration.credential.counter,
      transports: knownTransports(input.response.transports),
      synced: registration.credentialBackedUp,
    }),
  );
}

/**
 * Whether an assertion was signed by the key a store holds, and what its counter says afterwards. The
 * counter is the answer rather than a yes, because a caller has to write back the one it came with.
 */
export function verifiedAssertion(input: {
  party: RelyingParty;
  challenge: string;
  response: PasskeyAssertion;
  credential: StoredCredential;
}): Promise<Verified<{ readonly counter: number }>> {
  return answered(
    async () => {
      const outcome = await verifyAuthenticationResponse({
        response: {
          id: input.response.id,
          rawId: input.response.rawId,
          type: input.response.type,
          clientExtensionResults: {},
          response: {
            clientDataJSON: input.response.clientDataJSON,
            authenticatorData: input.response.authenticatorData,
            signature: input.response.signature,
            userHandle: input.response.userHandle,
          },
        },
        expectedChallenge: input.challenge,
        expectedOrigin: input.party.origin,
        expectedRPID: input.party.id,
        credential: {
          id: input.credential.id,
          publicKey: Uint8Array.from(Buffer.from(input.credential.publicKey, 'base64url')),
          counter: input.credential.counter,
          transports: [...input.credential.transports],
        },
        requireUserVerification: true,
      });
      return outcome.verified ? outcome.authenticationInfo : undefined;
    },
    (authentication) => ({ counter: authentication.newCounter }),
  );
}

/**
 * The challenge a ceremony answered, read out of the client data so the store can be asked for it.
 * This runs before anything has been verified, on a field somebody else wrote, so every way of being
 * malformed answers the same nothing: there is no shape of client data worth raising over.
 */
export function challengeIn(clientDataJSON: string): string | undefined {
  try {
    const client: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    const challenge = isRecord(client) ? client['challenge'] : undefined;
    return typeof challenge === 'string' && challenge !== '' ? challenge : undefined;
  } catch {
    return undefined;
  }
}
