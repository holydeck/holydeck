import { UNEXPECTED_ERROR } from '@holydeck/contracts/http';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';

import { UNEXPECTED_MESSAGE, unexpectedFailure, withSafeErrors } from './failures.js';

const LEAK = 'mongodb://holydeck:hunter2@records.invalid:27017 refused the connection';

const throwing = async (): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify({ logger: false });
  withSafeErrors(app);
  app.get('/boom', () => {
    throw new Error(LEAK);
  });
  await app.ready();
  return app;
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
