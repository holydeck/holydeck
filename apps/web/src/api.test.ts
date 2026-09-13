import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { UPDATE_REQUIRED } from '@holydeck/contracts/http';
import { describe, expect, it, vi } from 'vitest';

import { NETWORK_UNREACHABLE, UNREADABLE_RESPONSE, ask, needsUpdate } from './api.js';

const answering = (status: number, body: unknown) =>
  vi.fn(async () => ({ status, json: async () => body }));

const success = { data: { status: 'ok', locale: 'de' }, meta: { requestId: 'req-1', version: 1 } };

describe('asking the application for something', () => {
  it('tells the server which contract it speaks, on every request', async () => {
    const fetching = answering(200, success);
    await ask('/health', fetching);
    expect(fetching).toHaveBeenCalledWith('/health', {
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) },
    });
  });

  it('reads the data and the request id out of a success envelope', async () => {
    expect(await ask('/health', answering(200, success))).toEqual({
      ok: true,
      data: { status: 'ok', locale: 'de' },
      requestId: 'req-1',
      version: 1,
    });
  });

  it('reads the code, the message and the refused fields out of an error envelope', async () => {
    const body = {
      error: {
        code: 'request.validation_failed',
        message: 'The request could not be accepted.',
        requestId: 'req-2',
        fields: [{ path: 'service.title', code: 'field.empty', message: 'must not be empty' }],
      },
    };
    expect(await ask('/api/services', answering(422, body))).toEqual({
      ok: false,
      code: 'request.validation_failed',
      message: 'The request could not be accepted.',
      requestId: 'req-2',
      fields: [{ path: 'service.title', code: 'field.empty', message: 'must not be empty' }],
    });
  });

  it('reads an error envelope that refused nothing in particular', async () => {
    const body = { error: { code: 'resource.not_found', message: 'no such path', requestId: 'req-3' } };
    expect(await ask('/nope', answering(404, body))).toEqual({
      ok: false,
      code: 'resource.not_found',
      message: 'no such path',
      requestId: 'req-3',
      fields: [],
    });
  });

  it('says an answer was unreadable rather than rendering whatever arrived', async () => {
    const result = await ask('/health', answering(200, { status: 'ok' }));
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.code).toBe(UNREADABLE_RESPONSE);
    expect(result.ok ? [] : result.fields.map((field) => field.path)).toEqual(['success.data', 'success.meta']);
  });

  it('says a refusal it cannot read is unreadable, rather than reporting a code it invented', async () => {
    const result = await ask('/nope', answering(404, 'Not Found'));
    expect(result.ok ? undefined : result.code).toBe(UNREADABLE_RESPONSE);
    expect(result.ok ? [] : result.fields.map((field) => field.path)).toEqual(['error']);
  });

  it('says a body that is not JSON at all is unreadable, because a proxy may answer instead', async () => {
    const fetching = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));
    const result = await ask('/health', fetching);
    expect(result.ok ? undefined : result.code).toBe(UNREADABLE_RESPONSE);
    expect(result.ok ? undefined : result.message).toMatch(/Unexpected token/u);
  });

  it('reports a network it could not reach instead of throwing into whatever asked', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await ask('/health', offline)).toEqual({
      ok: false,
      code: NETWORK_UNREACHABLE,
      message: 'Failed to fetch',
      requestId: '',
      fields: [],
    });
  });


  it('still answers when the request was rejected with something that is not an error at all', async () => {
    const odd = vi.fn(async () => {
      throw 'the worker went away';
    });
    expect(await ask('/health', odd)).toEqual({
      ok: false,
      code: UNREADABLE_RESPONSE,
      message: 'the worker went away',
      requestId: '',
      fields: [],
    });
  });
});

describe('being told to update', () => {
  it('recognises the refusal that no retry can fix', async () => {
    const body = { error: { code: UPDATE_REQUIRED, message: 'Update required', requestId: 'req-4' } };
    const result = await ask('/api/contracts', answering(426, body));
    expect(needsUpdate(result)).toBe(true);
  });

  it('does not mistake a refusal a retry can fix for one that needs an update', async () => {
    const body = { error: { code: 'auth.session.expired', message: 'sign in again', requestId: 'req-5' } };
    expect(needsUpdate(await ask('/api/contracts', answering(401, body)))).toBe(false);
    expect(needsUpdate(await ask('/health', answering(200, success)))).toBe(false);
  });
});
