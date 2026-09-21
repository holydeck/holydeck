import { MESSAGE_CODES, UNEXPECTED_ERROR } from '@holydeck/contracts/http';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';

import { UNEXPECTED_MESSAGE, unexpectedFailure, withSafeErrors } from './failures.js';

import type { SafeErrorOptions } from './failures.js';
import type { ErrorEnvelope } from '@holydeck/contracts/http';

const LEAK = 'mongodb://holydeck:hunter2@records.invalid:27017 refused the connection';

const throwing = async (options?: SafeErrorOptions): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify({ logger: false });
  if (options === undefined) withSafeErrors(app);
  else withSafeErrors(app, options);
  app.get('/boom', () => {
    throw new Error(LEAK);
  });
  await app.ready();
  return app;
};

const bodyOf = async (options?: SafeErrorOptions): Promise<ErrorEnvelope['error']> => {
  const app = await throwing(options);
  const response = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return (response.json() as ErrorEnvelope).error;
};

describe('what a client is told when the fault is this server’s', () => {
  test('the answer is one stable code and one sentence, and not the sentence that was thrown', async () => {
    const app = await throwing();
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: UNEXPECTED_ERROR, message: UNEXPECTED_MESSAGE });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('records.invalid');
    await app.close();
  });

  test('the envelope carries the request identifier, because a report of it has to be findable', async () => {
    const app = await throwing();
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.json().error.requestId).toBe('req-1');
    await app.close();
  });

  // The detail is not lost, only moved: an operator reads it in the log, where the connection string in
  // it is already as exposed as the log itself.
  test('what was thrown is written to the log instead', async () => {
    const app = await throwing();
    const written: unknown[] = [];
    app.log.error = (value: unknown): void => {
      written.push(value);
    };
    await app.inject({ method: 'GET', url: '/boom' });
    expect(written).toHaveLength(1);
    expect((written[0] as Error).message).toBe(LEAK);
    await app.close();
  });

  test('the envelope is the one thing this module answers with, and nothing composes it twice', () => {
    expect(unexpectedFailure('req-8f31')).toEqual({
      error: { code: UNEXPECTED_ERROR, message: UNEXPECTED_MESSAGE, requestId: 'req-8f31' },
    });
  });
});

// The developer-diagnostics half of OPER-03. What is being protected is the difference between the two
// blocks below: the same thrown error, answered once with a code and once with the stack that produced
// it. The second answer is a debugging aid on a developer's own machine and an information disclosure
// anywhere else, which is why nothing short of the deployment's own configuration can ask for it.
describe('developer diagnostics are absent unless a deployment explicitly asked for them', () => {
  test('are absent by default, when the installer is called the way every route in this server calls it', async () => {
    expect(await bodyOf()).toEqual({
      code: UNEXPECTED_ERROR,
      message: UNEXPECTED_MESSAGE,
      requestId: 'req-1',
    });
  });

  test('are absent when the setting is off, which is the shape an ordinary installation runs in', async () => {
    const error = await bodyOf({ diagnostics: false });
    expect(error.diagnostics).toBeUndefined();
    expect(error).toEqual({ code: UNEXPECTED_ERROR, message: UNEXPECTED_MESSAGE, requestId: 'req-1' });
  });

  // The bullet in its own words: with the setting off, a stable code and no internal detail. Asserted
  // over the whole body rather than over the fields this module happens to name, because what leaks is
  // whatever somebody adds later without thinking about who reads it.
  test('with the setting off the answer is a stable code and carries no internal detail at all', async () => {
    const app = await throwing({ diagnostics: false });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();
    expect(response.json()).toEqual({
      error: { code: UNEXPECTED_ERROR, message: UNEXPECTED_MESSAGE, requestId: 'req-1' },
    });
    for (const internal of ['hunter2', 'records.invalid', 'mongodb://', 'at ', '.ts:', 'Error:', 'node:']) {
      expect(response.body).not.toContain(internal);
    }
    expect(MESSAGE_CODES.some((entry) => entry.code === UNEXPECTED_ERROR && entry.stable)).toBe(true);
  });

  test('appear only when the deployment turned them on, and then carry what was actually thrown', async () => {
    const error = await bodyOf({ diagnostics: true });
    expect(error.code).toBe(UNEXPECTED_ERROR);
    expect(error.message).toBe(UNEXPECTED_MESSAGE);
    expect(error.diagnostics?.message).toBe(LEAK);
    expect(error.diagnostics?.stack).toContain('failures.test.ts');
  });

  // Even turned on, the code and the sentence are the same ones. A client parsing the envelope must not
  // have to behave differently on a machine where somebody enabled this.
  test('do not change the code or the sentence a client reads, only add a field beside them', async () => {
    const off = await bodyOf({ diagnostics: false });
    const on = await bodyOf({ diagnostics: true });
    expect({ ...on, diagnostics: undefined }).toEqual({ ...off, diagnostics: undefined });
  });

  test('carry a message even for something thrown that was never an error and has no stack', async () => {
    const app = Fastify({ logger: false });
    withSafeErrors(app, { diagnostics: true });
    app.get('/boom', () => {
      throw 'a bare string, which JavaScript permits and libraries do';
    });
    await app.ready();
    const error = ((await app.inject({ method: 'GET', url: '/boom' })).json() as ErrorEnvelope).error;
    await app.close();
    expect(error.diagnostics).toEqual({ message: 'a bare string, which JavaScript permits and libraries do' });
  });

  test('carry a message for an error that arrived without a stack, and invent no trace for it', async () => {
    const app = Fastify({ logger: false });
    withSafeErrors(app, { diagnostics: true });
    app.get('/boom', () => {
      const error = new Error(LEAK);
      delete error.stack;
      throw error;
    });
    await app.ready();
    const error = ((await app.inject({ method: 'GET', url: '/boom' })).json() as ErrorEnvelope).error;
    await app.close();
    expect(error.diagnostics).toEqual({ message: LEAK });
  });

  // The whole point of the field being optional rather than nulled out: an envelope that always carried
  // a `diagnostics` key would tell anyone who asked whether this deployment has them enabled.
  test('leave no trace in the envelope when off, not even an empty key', async () => {
    const app = await throwing({ diagnostics: false });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();
    expect(Object.keys((response.json() as ErrorEnvelope).error)).toEqual(['code', 'message', 'requestId']);
  });

  // Whichever way it is answered, the detail is in the log: that is where it was always meant to be read.
  test('are written to the log either way, so turning them off never loses them', async () => {
    for (const diagnostics of [false, true]) {
      const app = await throwing({ diagnostics });
      const written: unknown[] = [];
      app.log.error = (value: unknown): void => {
        written.push(value);
      };
      await app.inject({ method: 'GET', url: '/boom' });
      await app.close();
      expect((written[0] as Error).message).toBe(LEAK);
    }
  });
});
