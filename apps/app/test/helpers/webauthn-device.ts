// The phone at the other end of a WebAuthn ceremony, standing in for a browser the tests cannot run: one
// P-256 key pair, one credential id, and the two payloads `@simplewebauthn/server` is asked to verify. It
// signs for real, so accepting what it produces proves the server's verification rather than a fixture —
// and it can be told to sign for the wrong origin or to leave user verification unclaimed, which is the
// only way the branches that refuse a ceremony are ever reached. A real authenticator refuses to lie.
//
// The CBOR encoder below is this file's own. Two shapes are written, a map of small integers and byte
// strings and a map of three named fields, and a helper that exists to keep a dependency out of the
// server is a poor place to add one — the same trade `src/otp.ts` made when it wrote RFC 6238 out.

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';

type CborValue = number | string | Uint8Array | ReadonlyMap<number | string, CborValue>;

/** A CBOR head: the major type in the top three bits, then the argument inline or in 1, 2 or 4 bytes. */
function cborHead(major: number, argument: number): Buffer {
  const prefix = major << 5;
  if (argument < 24) return Buffer.from([prefix | argument]);
  if (argument < 0x100) return Buffer.from([prefix | 24, argument]);
  if (argument < 0x1_0000) {
    const head = Buffer.from([prefix | 25, 0, 0]);
    head.writeUInt16BE(argument, 1);
    return head;
  }
  const head = Buffer.from([prefix | 26, 0, 0, 0, 0]);
  head.writeUInt32BE(argument, 1);
  return head;
}

/** Major type 1 holds one less than the magnitude, which is why -1 is written as the argument zero. */
function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') return cborHead(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const pairs = [...value].map(([key, item]) => Buffer.concat([cbor(key), cbor(item)]));
  return Buffer.concat([cborHead(5, value.size), ...pairs]);
}

const USER_PRESENT = 0x01;

const USER_VERIFIED = 0x04;

const ATTESTED_CREDENTIAL = 0x40;

/** Sixteen zero bytes, which is what a platform authenticator reports rather than a model it can be traced by. */
const AAGUID = Buffer.alloc(16);

const CREDENTIAL_ID_BYTES = 32;

/** The COSE form of an ES256 key: key type 2 (EC2), algorithm -7, curve 1 (P-256), then the two coordinates. */
const coseKey = (x: Buffer, y: Buffer): Buffer =>
  cbor(
    new Map<number, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );

/**
 * What the authenticator signs over: the relying party it believes it is answering, what it did about the
 * person in front of it, and how many times it has been used. A registration appends the credential it
 * just made; an assertion stops after the counter, which is why the attested block is optional here.
 */
const authenticatorData = (rpId: string, flags: number, signCount: number, attested?: Buffer): Buffer => {
  const header = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(header);
  header.writeUInt8(flags, 32);
  header.writeUInt32BE(signCount, 33);
  return attested === undefined ? header : Buffer.concat([header, attested]);
};

const attestedCredential = (rawId: Buffer, publicKey: Buffer): Buffer => {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(rawId.length);
  return Buffer.concat([AAGUID, length, rawId, publicKey]);
};

/** A user handle travels as the bytes of an account identifier rather than as its text. */
const encodedHandle = (handle: string | undefined): string | undefined =>
  handle === undefined ? undefined : Buffer.from(handle, 'utf8').toString('base64url');

/** What a browser collects and the server hashes. `crossOrigin` is false because there is no iframe here. */
const clientData = (type: string, challenge: string, origin: string): Buffer =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

/** Knobs shared by both ceremonies, each one a way of being wrong that a real authenticator cannot be. */
export interface CeremonyOptions {
  /** Sent in the client data instead of the device's own, which is how a phished origin is presented. */
  readonly origin?: string;
  /** Hashed into the authenticator data instead of the device's own, for a credential of another site. */
  readonly rpId?: string;
  /** Clears the user-verified flag when false: present but unproven, the state a bare tap leaves. */
  readonly userVerified?: boolean;
  /** Reported verbatim and leaves the device's own count alone, so passing one twice replays a count. */
  readonly signCount?: number;
}

export interface RegisterOptions extends CeremonyOptions {
  /** Carried through to the response as the browser would; the server may keep it beside the credential. */
  readonly transports?: string[];
}

export interface AuthenticateOptions extends CeremonyOptions {
  /** The account the credential was made for, returned base64url as a discoverable credential does. */
  readonly userHandle?: string;
  /** Signs over different bytes: still a well-formed signature, still this key's, and still not valid. */
  readonly wrongSignature?: boolean;
}

export interface WebAuthnDevice {
  /** The credential id base64url, which is both the `id` a response carries and the key a store looks up by. */
  readonly credentialId: string;
  /** The COSE public key bytes, which is what a store keeps and what a signature is later checked against. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** The three fields a store holds, ready to hand to `verifyAuthenticationResponse`. */
  credential(counter?: number): WebAuthnCredential;
  register(challenge: string, options?: RegisterOptions): RegistrationResponseJSON;
  authenticate(challenge: string, options?: AuthenticateOptions): AuthenticationResponseJSON;
}

export interface WebAuthnDeviceOptions {
  /** The relying party this device holds a credential for; the server matches its hash, never the string. */
  readonly rpId: string;
  /** The page the device believes it is answering, written into the client data verbatim. */
  readonly origin: string;
}

/**
 * A device that has never been used. Its counter starts at zero and moves on every ceremony, so a
 * registration reports zero, the first assertion reports one, and an assertion is accepted without a test
 * having to say anything about counters — which leaves `signCount` free to mean only a deliberate replay.
 */
export function webauthnDevice({ rpId, origin }: WebAuthnDeviceOptions): WebAuthnDevice {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // An SPKI export ends in the uncompressed point, so the last sixty-four bytes are x followed by y.
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const cose = coseKey(spki.subarray(spki.length - 64, spki.length - 32), spki.subarray(spki.length - 32));
  const rawId = randomBytes(CREDENTIAL_ID_BYTES);
  const id = rawId.toString('base64url');
  const publicKey = Uint8Array.from(cose);

  let used = 0;
  const signCountFor = (chosen: number | undefined): number => {
    if (chosen !== undefined) return chosen;
    used += 1;
    return used - 1;
  };

  const flagsFor = (options: CeremonyOptions, attested: number): number =>
    USER_PRESENT | attested | (options.userVerified === false ? 0 : USER_VERIFIED);

  return {
    credentialId: id,
    publicKey,

    credential: (counter = 0): WebAuthnCredential => ({ id, publicKey, counter }),

    register(challenge, options = {}) {
      const clientDataJSON = clientData('webauthn.create', challenge, options.origin ?? origin);
      const authData = authenticatorData(
        options.rpId ?? rpId,
        flagsFor(options, ATTESTED_CREDENTIAL),
        signCountFor(options.signCount),
        attestedCredential(rawId, cose),
      );
      // Attestation format `none` with an empty statement: the product takes the key on the server's own
      // terms and does not follow a manufacturer chain, so there is nothing for this device to assert.
      const attestationObject = cbor(
        new Map<string, CborValue>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, CborValue>()],
          ['authData', authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
          transports: options.transports ?? ['internal'],
        },
      };
    },

    authenticate(challenge, options = {}) {
      const clientDataJSON = clientData('webauthn.get', challenge, options.origin ?? origin);
      const authData = authenticatorData(options.rpId ?? rpId, flagsFor(options, 0), signCountFor(options.signCount));
      const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      // A wrong signature is one made over other bytes rather than one made of other bytes: a corrupted
      // signature fails to parse, which is a different refusal from the one a forged assertion earns.
      const payload = options.wrongSignature === true ? Buffer.concat([signed, Buffer.from([0])]) : signed;
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: createSign('sha256').update(payload).sign(pair.privateKey).toString('base64url'),
          userHandle: encodedHandle(options.userHandle),
        },
      };
    },
  };
}
