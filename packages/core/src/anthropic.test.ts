import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MODEL,
  RESOLVE_TOOL_NAME,
  resolveBookCodes,
} from './anthropic.js';
import { bundledCanon } from './canon.js';
import { HolyDeckError } from './messages.js';
import type { HttpPost } from './anthropic.js';

/** Obviously not a key. Nothing in this repo may carry a string that could pass for a real one. */
const API_KEY = 'test-api-key';

const CANON = bundledCanon().books;

interface SentRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function recorder(reply: { status: number; body: string }): { sent: SentRequest[]; httpPost: HttpPost } {
  const sent: SentRequest[] = [];
  const httpPost: HttpPost = async (url, body, headers) => {
    sent.push({ url, body, headers });
    return reply;
  };
  return { sent, httpPost };
}

function toolReply(input: unknown, usage?: unknown): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'msg_test',
      content: [{ type: 'tool_use', id: 'toolu_test', name: RESOLVE_TOOL_NAME, input }],
      usage: usage === undefined ? { input_tokens: 412, output_tokens: 27 } : usage,
    }),
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<HolyDeckError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HolyDeckError);
    return error as HolyDeckError;
  }
  throw new Error('expected the call to throw');
}

describe('resolveBookCodes', () => {
  it('asks the Messages API to pick from the canon and answers with the token-to-code map', async () => {
    const { sent, httpPost } = recorder(toolReply({ resolutions: [{ token: '1. Mose', usfm: 'GEN' }] }));
    const result = await resolveBookCodes(['1. Mose'], CANON, { apiKey: API_KEY, httpPost });

    expect(result).toEqual({ codes: { '1. Mose': 'GEN' }, requestTokens: 412, responseTokens: 27 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(sent[0]!.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    });
  });

  it('constrains the answer with a forced tool choice over a 66-value USFM enum', async () => {
    const { sent, httpPost } = recorder(toolReply({ resolutions: [] }));
    await resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost });

    const body = JSON.parse(sent[0]!.body) as {
      model: string;
      system: string;
      tool_choice: unknown;
      tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.tool_choice).toEqual({ type: 'tool', name: RESOLVE_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.name).toBe(RESOLVE_TOOL_NAME);

    const items = (
      body.tools[0]!.input_schema as {
        properties: { resolutions: { items: { properties: { token: unknown; usfm: { enum: string[] } } } } };
      }
    ).properties.resolutions.items;
    expect(items.properties.usfm.enum).toEqual(CANON.map((book) => book.usfm));
    expect(items.properties.usfm.enum).toHaveLength(66);
    expect(Object.keys(items.properties)).toEqual(['token', 'usfm']);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('Roman') }]);
    expect(body.system).toContain('USFM');
  });

  it('asks about every token it was handed, in the order it was handed them', async () => {
    const { sent, httpPost } = recorder(toolReply({ resolutions: [] }));
    await resolveBookCodes(['Roman', 'Offenbarung'], CANON, { apiKey: API_KEY, httpPost });

    const body = JSON.parse(sent[0]!.body) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content.indexOf('Roman')).toBeLessThan(body.messages[0]!.content.indexOf('Offenbarung'));
  });

  it('uses the model the caller names instead of the default', async () => {
    const { sent, httpPost } = recorder(toolReply({ resolutions: [] }));
    await resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, model: 'a-named-model', httpPost });

    expect((JSON.parse(sent[0]!.body) as { model: string }).model).toBe('a-named-model');
  });

  it.each([
    ['there is no usage block at all', null],
    ['the counts are not numbers', { input_tokens: 'lots', output_tokens: 'lots' }],
  ])('leaves the token counts out when %s', async (_case, usage) => {
    const { httpPost } = recorder(toolReply({ resolutions: [{ token: 'Roman', usfm: 'ROM' }] }, usage));
    expect(await resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost })).toEqual({
      codes: { Roman: 'ROM' },
    });
  });

  it('posts through the platform fetch when the caller injects no transport', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(toolReply({ resolutions: [{ token: 'Roman', usfm: 'ROM' }] }).body, { status: 200 }));
    try {
      expect(await resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY })).toEqual({
        codes: { Roman: 'ROM' },
        requestTokens: 412,
        responseTokens: 27,
      });
      expect(fetchSpy).toHaveBeenCalledWith(ANTHROPIC_MESSAGES_URL, expect.objectContaining({ method: 'POST' }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ['there is none at all', ''],
    ['it is nothing but spaces', '   '],
  ])('refuses without an API key when %s, before any request goes out', async (_case, apiKey) => {
    const { sent, httpPost } = recorder(toolReply({ resolutions: [] }));
    const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey, httpPost }));

    expect(failure.code).toBe('ai_api_key_missing');
    expect(sent).toEqual([]);
  });

  it('reports a transport that throws as a failed request', async () => {
    const httpPost: HttpPost = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost }));

    expect(failure.code).toBe('ai_request_failed');
    expect(failure.message).toContain('getaddrinfo ENOTFOUND');
  });

  it.each([
    ['a refusal', 401],
    ['a rate limit', 429],
    ['a server fault', 503],
  ])('reports %s as a failed request', async (_case, status) => {
    const { httpPost } = recorder({ status, body: '{"error":{"type":"x"}}' });
    const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost }));

    expect(failure.code).toBe('ai_request_failed');
    expect(failure.message).toContain(String(status));
  });

  it.each([
    ['the body is not JSON at all', { status: 200, body: 'not json' }],
    ['the body is JSON but not an object', { status: 200, body: 'null' }],
    ['there is no content list', { status: 200, body: '{}' }],
    ['no block is a tool call', { status: 200, body: '{"content":[{"type":"text","text":"GEN"}]}' }],
    [
      'the tool call names another tool',
      { status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: 'other', input: { resolutions: [] } }] }) },
    ],
    ['the tool call carries no input', { status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: RESOLVE_TOOL_NAME }] }) }],
    ['the resolutions are not a list', toolReply({ resolutions: { Roman: 'ROM' } })],
    ['a resolution is not an object', toolReply({ resolutions: ['ROM'] })],
    ['a resolution carries no token', toolReply({ resolutions: [{ usfm: 'ROM' }] })],
    ['a resolution carries no code', toolReply({ resolutions: [{ token: 'Roman' }] })],
    ['a resolution names a token nobody asked about', toolReply({ resolutions: [{ token: 'Hosea', usfm: 'HOS' }] })],
    ['a resolution answers with a code outside the canon', toolReply({ resolutions: [{ token: 'Roman', usfm: 'XYZ' }] })],
    ['the same token is answered twice', toolReply({ resolutions: [{ token: 'Roman', usfm: 'ROM' }, { token: 'Roman', usfm: 'GEN' }] })],
  ])('refuses an answer this build cannot use when %s', async (_case, reply) => {
    const { httpPost } = recorder(reply);
    const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost }));

    expect(failure.code).toBe('ai_response_invalid');
  });

  it('reports a transport that answers with nothing as an unusable answer rather than crashing', async () => {
    const httpPost = (async () => undefined) as unknown as HttpPost;
    const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost }));

    expect(failure.code).toBe('ai_response_invalid');
  });

  it('keeps the API key out of every failure it reports', async () => {
    const replies = [
      { status: 401, body: `{"key":"${API_KEY}"}` },
      { status: 200, body: `{"content":[{"type":"text","text":"${API_KEY}"}]}` },
    ];
    for (const reply of replies) {
      const { httpPost } = recorder(reply);
      const failure = await failureOf(() => resolveBookCodes(['Roman'], CANON, { apiKey: API_KEY, httpPost }));
      expect(failure.message).not.toContain(API_KEY);
      expect(JSON.stringify(failure.params)).not.toContain(API_KEY);
    }
  });
});
