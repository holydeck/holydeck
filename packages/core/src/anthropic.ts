// The one place this package talks to the Anthropic Messages API, and the only thing it asks for: the
// USFM code of a book name the deterministic matcher could not place.
//
// Three rules shape it. It is optional — nothing here runs unless a key is configured and a book name
// was actually left over, and `sermon-ai.ts` degrades to its deterministic result when it fails. It is
// constrained — the answer comes back through a forced tool call whose schema offers exactly the 66
// codes of the canon, and every value is checked against that canon again on arrival, because a schema
// is a request and not a guarantee. And it carries no SDK: the transport is a plain injectable function,
// the same shape `fetcher.ts` uses, so a test drives it without a network and without a fake server.

import { HolyDeckError } from './messages.js';

export type HttpPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export const ANTHROPIC_VERSION = '2023-06-01';

/** Small and fast: the work is picking one of 66 codes, not writing prose. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export const RESOLVE_TOOL_NAME = 'resolve_books';

/** Enough for one code per book of the canon, and far too little for anything else. */
const MAX_TOKENS = 1024;

/**
 * The rules a pastor's book names need read to them: they arrive misspelled, abbreviated, or in another
 * language, and what is wanted back is the book of the Protestant canon each one means. Stated here
 * rather than kept anywhere outside this repository — the Messages API is stateless, so a prompt that
 * lives somewhere else is a prompt this build cannot reproduce.
 */
const SYSTEM_PROMPT = [
  'You map book names copied out of a sermon note to the books of the Protestant canon.',
  'A name may be misspelled, abbreviated, or written in a language other than English.',
  'Correct the spelling, read a non-English name as the English book it names, and answer with that',
  "book's USFM code.",
  'Answer only through the resolve_books tool, and leave a name out of your answer rather than guessing',
  'when nothing in the canon is clearly the book it means.',
].join(' ');

export interface ResolveBookCodesOptions {
  apiKey: string;
  model?: string;
  httpPost?: HttpPost;
}

export interface ResolvedBookCodes {
  /** Every token the answer placed, mapped to its USFM code. A token it left out is simply absent. */
  codes: Record<string, string>;
  /** What the call cost, when the answer said; for an audit entry, never for a decision. */
  requestTokens?: number;
  responseTokens?: number;
}

const defaultHttpPost: HttpPost = async (url, body, headers) => {
  const response = await fetch(url, { method: 'POST', body, headers });
  return { status: response.status, body: await response.text() };
};

function invalid(reason: string, usage: Record<string, number> = {}): HolyDeckError {
  return new HolyDeckError('ai_response_invalid', { reason, ...usage });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The tool the answer has to come through: one code per token, and only codes the canon holds. */
export function resolveBooksTool(canon: { usfm: string; name: string }[]): Record<string, unknown> {
  return {
    name: RESOLVE_TOOL_NAME,
    description: 'Report the USFM code of each book name you were given. Leave out any name you cannot place.',
    input_schema: {
      type: 'object',
      properties: {
        resolutions: {
          type: 'array',
          description: 'One entry per book name you could place.',
          items: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'The book name exactly as it was given to you.' },
              usfm: { type: 'string', enum: canon.map((book) => book.usfm) },
            },
            required: ['token', 'usfm'],
            additionalProperties: false,
          },
        },
      },
      required: ['resolutions'],
      additionalProperties: false,
    },
  };
}

function requestBody(tokens: string[], canon: { usfm: string; name: string }[], model: string): string {
  return JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [resolveBooksTool(canon)],
    tool_choice: { type: 'tool', name: RESOLVE_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: ['Book names to place:', ...tokens.map((token) => `- ${token}`)].join('\n'),
      },
    ],
  });
}

function readAnswer(
  response: { status: number; body: string },
  tokens: string[],
  canon: { usfm: string; name: string }[],
): ResolvedBookCodes {
  if (response.status < 200 || response.status >= 300) {
    throw new HolyDeckError('ai_request_failed', { reason: `HTTP ${response.status}` });
  }
  const payload: unknown = JSON.parse(response.body);
  // Read before anything below can throw: an audit entry wants the call's cost even when the shape
  // that came back is one this build has to refuse.
  const usage = isRecord(payload)
    ? (payload.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined)
    : undefined;
  const usageParams: Record<string, number> = {};
  if (typeof usage?.input_tokens === 'number') usageParams['requestTokens'] = usage.input_tokens;
  if (typeof usage?.output_tokens === 'number') usageParams['responseTokens'] = usage.output_tokens;
  const fail = (reason: string): HolyDeckError => invalid(reason, usageParams);

  const content = isRecord(payload) ? payload.content : undefined;
  if (!Array.isArray(content)) throw fail('the answer carried no content');
  // Counted before the name is checked: a tool call for something else sitting alongside the real one
  // is still more than one block, not zero — the count has to see every block before any is judged.
  const toolUseBlocks = content.filter(
    (block) => isRecord(block) && block.type === 'tool_use',
  ) as { name?: unknown; input?: { resolutions?: unknown } }[];
  if (toolUseBlocks.length === 0) throw fail(`the answer carried no ${RESOLVE_TOOL_NAME} call`);
  if (toolUseBlocks.length > 1) throw fail(`the answer carried more than one ${RESOLVE_TOOL_NAME} call`);
  const call = toolUseBlocks[0]!;
  if (call.name !== RESOLVE_TOOL_NAME) throw fail(`the answer carried no ${RESOLVE_TOOL_NAME} call`);
  const resolutions = call.input?.resolutions;
  if (!Array.isArray(resolutions)) throw fail('the tool call carried no list of resolutions');

  const asked = new Set(tokens);
  const known = new Set(canon.map((book) => book.usfm));
  const codes = new Map<string, string>();
  for (const entry of resolutions) {
    if (!isRecord(entry)) throw fail('a resolution was not an object');
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes('token') || !keys.includes('usfm')) {
      throw fail('a resolution carried properties beyond its book name and its code');
    }
    const { token, usfm } = entry;
    if (typeof token !== 'string' || typeof usfm !== 'string') {
      throw fail('a resolution was missing its book name or its code');
    }
    if (!asked.has(token)) throw fail('a resolution named a book that was never asked about');
    if (!known.has(usfm)) throw fail('a resolution answered with a code the canon does not hold');
    if (codes.has(token)) throw fail('a book name was answered twice');
    codes.set(token, usfm);
  }

  return { codes: Object.fromEntries(codes), ...usageParams };
}

/**
 * Asks for the USFM code of every token handed in, and answers with the map of the ones that came back.
 *
 * Every failure leaves here as a `HolyDeckError`, so a caller has three codes to tell apart and nothing
 * else to catch: `ai_api_key_missing` before anything is sent, `ai_request_failed` when the call did not
 * come back, `ai_response_invalid` when it came back as something this build cannot use. None of them
 * carries the key, the prompt, or the answer's body — a failure says what went wrong structurally, since
 * anything more would put a pastor's message into a log.
 */
export async function resolveBookCodes(
  tokens: string[],
  canon: { usfm: string; name: string }[],
  options: ResolveBookCodesOptions,
): Promise<ResolvedBookCodes> {
  const apiKey = options.apiKey.trim();
  if (apiKey === '') throw new HolyDeckError('ai_api_key_missing');
  const post = options.httpPost ?? defaultHttpPost;
  let response: { status: number; body: string };
  try {
    response = await post(ANTHROPIC_MESSAGES_URL, requestBody(tokens, canon, options.model ?? DEFAULT_MODEL), {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    });
  } catch {
    // The caught exception's own message can carry the key or the prompt (a transport that echoes the
    // request it failed to send, a proxy error quoting the URL) — reported as a fixed, generic reason
    // instead, never interpolated, so a transport failure can never put either into a notice.
    throw new HolyDeckError('ai_request_failed', { reason: 'the request could not be sent' });
  }
  try {
    return readAnswer(response, tokens, canon);
  } catch (error) {
    // Anything the reader did not name itself — unparseable JSON, a transport that answered with
    // nothing — is the same thing to a caller: an answer that cannot be used. Reported as that, and
    // without the body, so a malformed reply never reaches a log through the error message.
    if (error instanceof HolyDeckError) throw error;
    throw invalid('the answer could not be read');
  }
}
