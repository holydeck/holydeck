import { errorEnvelope } from '@holydeck/contracts/http';
import { describe, expect, test } from 'vitest';

import { RECORDS } from './records.js';
import {
  MINIMUM_SECRET,
  REDACTED,
  SECRET_NAMES,
  isSecretName,
  redactingLogger,
  redactorFor,
  secretsIn,
} from './redaction.js';
import { DEFAULT_SETTINGS, loadSettings } from './settings.js';

const CORPUS_TOKEN = 'corpus-token-0123456789abcdef';
const MONGO_PASSWORD = 'mongo-password-fedcba9876543210';

const redact = redactorFor([CORPUS_TOKEN, MONGO_PASSWORD]);

const text = (value: unknown): string => JSON.stringify(redact(value));

describe('names that say the value behind them is a secret', () => {
  test('a name is read in the parts it is written in, whichever way it is written', () => {
    for (const name of ['token', 'corpusToken', 'CORPUS_TOKEN', 'corpus_token', 'x-holydeck-csrf']) {
      expect(isSecretName(name), name).toBe(true);
    }
    expect(SECRET_NAMES).toContain('token');
  });

  test('the names a log is worth keeping are left alone', () => {
    for (const name of ['actor', 'locale', 'mongoUrl', 'correlationId', 'tokenizer', 'requestId']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});

describe('redacting a value', () => {
  test('a field a name says is a secret is replaced, however deep it is and whatever it holds', () => {
    expect(
      redact({
        actor: 'account:7f3a',
        headers: { cookie: 'holydeck_session=abc', authorization: 'Bearer abc' },
        settings: [{ corpusToken: CORPUS_TOKEN }, { password: { was: 'an object' } }],
      }),
    ).toEqual({
      actor: 'account:7f3a',
      headers: { cookie: REDACTED, authorization: REDACTED },
      settings: [{ corpusToken: REDACTED }, { password: REDACTED }],
    });
  });

  test('a secret this deployment holds is removed wherever it turns up, named or not', () => {
    expect(text({ detail: `the corpus refused ${CORPUS_TOKEN} at 10:00` })).not.toContain(CORPUS_TOKEN);
    expect(redact(`connect failed for ${MONGO_PASSWORD}`)).toBe(`connect failed for ${REDACTED}`);
    expect(redact([CORPUS_TOKEN])).toEqual([REDACTED]);
  });

  test('a credential is removed for its shape too, because a deployment holds secrets this one was not told', () => {
    expect(redact('mongodb://app:hunter2@db.example.invalid/holydeck')).toBe(
      `mongodb://app:${REDACTED}@db.example.invalid/holydeck`,
    );
    expect(redact('authorization: Bearer eyJhbGciOi.J9.abc')).toBe(`authorization: Bearer ${REDACTED}`);
  });

  // A needle that short matches ordinary words, and a log redacted down to nothing is a log nobody reads.
  // Shape is what catches those: the same value inside a connection string is still removed.
  test('a secret too short to be a needle is left as a word and still removed as a credential', () => {
    const short = redactorFor(['abc']);
    expect(short('abc is a sequence of letters')).toBe('abc is a sequence of letters');
    expect(short('mongodb://app:abc@db.example.invalid/holydeck')).toContain(REDACTED);
    expect(MINIMUM_SECRET).toBeGreaterThan(3);
  });

  test('what is not text and not a structure is handed back as it is', () => {
    expect(redact(7)).toBe(7);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    const when = new Date('2026-09-13T09:30:00.000Z');
    expect(redact({ at: when })).toEqual({ at: when });
  });

  test('an error is carried with its name, its message and its stack, all read the same way', () => {
    const error = new Error(`the corpus refused ${CORPUS_TOKEN}`);
    expect(redact({ err: error })).toEqual({
      err: { name: 'Error', message: `the corpus refused ${REDACTED}`, stack: expect.any(String) as unknown as string },
    });
    const stackless = Object.assign(new Error(`refused ${CORPUS_TOKEN}`), { stack: undefined });
    expect(redact(stackless)).toEqual({ name: 'Error', message: `refused ${REDACTED}`, stack: '' });
  });

  test('a structure that contains itself is reported as one rather than followed forever', () => {
    const loop: Record<string, unknown> = { actor: 'account:7f3a' };
    loop['self'] = loop;
    expect(redact(loop)).toEqual({ actor: 'account:7f3a', self: '[circular]' });
  });

  test('the secrets of a deployment are read off its settings, and an empty one is not a secret', () => {
    expect(secretsIn({ ...DEFAULT_SETTINGS })).toEqual([]);
    expect(
      secretsIn({
        ...DEFAULT_SETTINGS,
        corpusToken: CORPUS_TOKEN,
        mongoUrl: `mongodb://app:${MONGO_PASSWORD}@db.example.invalid/holydeck`,
      }),
    ).toEqual([CORPUS_TOKEN, MONGO_PASSWORD]);
    // An address with no credential in it carries no secret to remove, and is not made into one.
    expect(secretsIn({ ...DEFAULT_SETTINGS, mongoUrl: 'mongodb://db.example.invalid/holydeck' })).toEqual([]);
    expect(secretsIn({ ...DEFAULT_SETTINGS, mongoUrl: 'not a URL at all' })).toEqual([]);
  });
});

// The maintenance procedure this exercises: an operator rotates a secret by redeploying with a new
// value and restarting, which is a fresh `loadSettings` read the same way a restart's is (main.ts calls
// both the same way, in the same order, at boot). This proves a rotation actually reaches the redactor a
// fresh boot builds from it — not just that `secretsIn` can read a single settings snapshot.
describe('rotating a secret', () => {
  test('reloading settings after an operator rotates a secret protects the new value, not the stale one', () => {
    const before = loadSettings({ env: { HOLYDECK_MONGO_URL: `mongodb://app:${MONGO_PASSWORD}@mongo:27017/holydeck` } });
    const redactBefore = redactorFor(secretsIn(before.values));
    expect(redactBefore(`connect failed for ${MONGO_PASSWORD}`)).toBe(`connect failed for ${REDACTED}`);

    const ROTATED_PASSWORD = 'rotated-password-0123456789abcdef';
    const after = loadSettings({ env: { HOLYDECK_MONGO_URL: `mongodb://app:${ROTATED_PASSWORD}@mongo:27017/holydeck` } });
    const redactAfter = redactorFor(secretsIn(after.values));

    expect(redactAfter(`connect failed for ${ROTATED_PASSWORD}`)).toBe(`connect failed for ${REDACTED}`);
    // The rotated-away value is no longer this deployment's secret to protect, so a line naming it reads
    // as ordinary text after rotation — which is exactly why a rotation is complete only once the old
    // value has stopped appearing anywhere new gets logged.
    expect(redactAfter(`connect failed for ${MONGO_PASSWORD}`)).toBe(`connect failed for ${MONGO_PASSWORD}`);
  });
});

describe('what the logger writes', () => {
  test('every line goes through the same reading before it is written', () => {
    const logger = redactingLogger('debug', redact);
    expect(logger).toMatchObject({ level: 'debug' });
    const written: unknown[][] = [];
    const method = (...args: unknown[]): void => {
      written.push(args);
    };
    logger.hooks.logMethod.call(undefined, [{ corpusToken: CORPUS_TOKEN }, `sent ${CORPUS_TOKEN}`], method);
    expect(written).toEqual([[{ corpusToken: REDACTED }, `sent ${REDACTED}`]]);
  });
});

// A secret put deliberately into each of the three places a reader ever sees has to be gone from all
// three. The secret here is the one a deployment actually holds.
describe('a secret injected into what a reader sees', () => {
  test('is absent from a log line, an error envelope and an audit entry alike', () => {
    const line = redact({
      msg: `corpus request failed with ${CORPUS_TOKEN}`,
      req: { headers: { cookie: `holydeck_session=${CORPUS_TOKEN}`, 'x-holydeck-csrf': CORPUS_TOKEN } },
      settings: { corpusToken: CORPUS_TOKEN },
    });

    const envelope = redact(
      errorEnvelope('corpus.unavailable', `the corpus refused ${CORPUS_TOKEN}`, 'req-0f9c2a41', [
        { path: 'authorization', code: 'auth.forbidden', message: `sent ${CORPUS_TOKEN}` },
      ]),
    );

    const audit = redact({
      ...Object.fromEntries(Object.keys(RECORDS.auditEvents.fields).map((field) => [field, 'recorded'])),
      detail: `the operator pasted ${CORPUS_TOKEN}`,
    });

    for (const [what, value] of [['log', line], ['envelope', envelope], ['audit', audit]] as const) {
      expect(JSON.stringify(value), what).not.toContain(CORPUS_TOKEN);
      expect(JSON.stringify(value), what).toContain(REDACTED);
    }
    // The rest of the line survives: a redaction that removes the whole record removes the reason to log.
    expect(JSON.stringify(line)).toContain('corpus request failed');
  });
});
