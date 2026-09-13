import { MESSAGE_CODES } from '@holydeck/contracts/http';
import { corpusBoundaryProblems } from '@holydeck/contracts/corpus';
import { describe, expect, it } from 'vitest';

import {
  CORPUS_WORDING,
  LIBRARY_NOT_CONFIGURED,
  LIBRARY_UNAVAILABLE,
  LIBRARY_UNEXPECTED,
  corpusBinding,
  corpusBoundaryFor,
  corpusClient,
  corpusProbeProblems,
  probeCorpusIsClosed,
} from './corpus.js';

import type { Fetching } from './corpus.js';

const TOKEN = 'a'.repeat(24);
const INTERNAL = { url: 'http://corpus:8080', token: TOKEN };

function answering(answers: Array<{ status: number; body: unknown }>): {
  fetching: Fetching;
  asked: Array<{ url: string; headers: Readonly<Record<string, string>> }>;
} {
  const asked: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const queue = [...answers];
  const fetching: Fetching = (url, init) => {
    asked.push({ url, headers: init.headers });
    const answer = queue.shift() ?? { status: 500, body: {} };
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
  return { fetching, asked };
}

const unreachable: Fetching = () => Promise.reject(new Error('connect ECONNREFUSED'));

const translations = [
  { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
];

describe('the address the library is allowed to answer at', () => {
  it('reads an address inside the deployment as internal', () => {
    expect(corpusBinding('http://127.0.0.1:8080')).toBe('loopback');
    expect(corpusBinding('http://localhost:8080')).toBe('loopback');
    expect(corpusBinding('http://[::1]:8080')).toBe('loopback');
    expect(corpusBinding('http://corpus:8080')).toBe('internal-network');
    expect(corpusBinding('http://10.0.0.4:8080')).toBe('internal-network');
    expect(corpusBinding('http://172.16.4.4:8080')).toBe('internal-network');
    // Written as octets so that no address anybody runs a network on is spelled out in this file.
    expect(corpusBinding(`http://${[192, 168, 0, 4].join('.')}:8080`)).toBe('internal-network');
  });

  it('reads a reachable address as itself, so the boundary check can name what is wrong', () => {
    expect(corpusBinding('https://corpus.example.com')).toBe('corpus.example.com');
    expect(corpusBinding('http://8.8.8.8')).toBe('8.8.8.8');
    expect(corpusBinding('http://172.32.0.1')).toBe('172.32.0.1');
    expect(corpusBinding('http://172.8.0.1')).toBe('172.8.0.1');
    expect(corpusBinding('http://11.0.0.1')).toBe('11.0.0.1');
  });
});

describe('the boundary this deployment presents', () => {
  it('grades clean when the library is internal and the client presents a credential', () => {
    expect(corpusBoundaryProblems(corpusBoundaryFor(INTERNAL))).toEqual([]);
  });

  it('refuses a library the outside world could reach', () => {
    const problems = corpusBoundaryProblems(corpusBoundaryFor({ url: 'https://corpus.example.com', token: TOKEN }));
    expect(problems).toContain('corpus port: binding corpus.example.com is not internal');
    expect(problems).toContain('corpus port: is publicly routable');
  });

  it('refuses a library nothing has to authenticate against', () => {
    expect(corpusBoundaryProblems(corpusBoundaryFor({ url: 'http://corpus:8080', token: '' })))
      .toContain('corpus port: is unauthenticated');
  });
});

describe('asking the library for its translations', () => {
  it('asks the released route, presenting the credential the corpus expects', async () => {
    const { fetching, asked } = answering([{ status: 200, body: { translations } }]);
    const result = await corpusClient(INTERNAL, fetching).translations();
    expect(asked).toEqual([{ url: 'http://corpus:8080/api/v1/translations', headers: { authorization: `Bearer ${TOKEN}` } }]);
    expect(result).toEqual({ ok: true, value: translations });
  });

  it('joins the path onto an address written with a trailing slash', async () => {
    const { fetching, asked } = answering([{ status: 200, body: { translations: [] } }]);
    await corpusClient({ url: 'http://corpus:8080/', token: TOKEN }, fetching).translations();
    expect(asked[0]?.url).toBe('http://corpus:8080/api/v1/translations');
  });

  it('refuses an answer it cannot read, rather than passing a half-read list on', async () => {
    for (const body of [{ translations: [{ id: 1 }] }, { translations: 'none' }, {}, 'not an object']) {
      const { fetching } = answering([{ status: 200, body }]);
      const result = await corpusClient(INTERNAL, fetching).translations();
      expect(result).toEqual({
        ok: false,
        refusal: { code: 'corpus.unexpected_error', status: 500, message: CORPUS_WORDING['corpus.unexpected_error'] },
      });
    }
  });

  it('refuses an answer that is not an answer at all', async () => {
    const fetching: Fetching = () => Promise.resolve({ status: 200, json: () => Promise.reject(new Error('not JSON')) });
    const result = await corpusClient(INTERNAL, fetching).translations();
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.unexpected_error', status: 500, message: CORPUS_WORDING['corpus.unexpected_error'] },
    });
  });

  it('says the library is unavailable when it cannot be reached at all', async () => {
    const result = await corpusClient(INTERNAL, unreachable).translations();
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.unavailable', status: 503, message: CORPUS_WORDING['corpus.unavailable'] },
    });
  });

  it('says the same when no library is configured, and asks nothing', async () => {
    const { fetching, asked } = answering([]);
    const result = await corpusClient({ url: '', token: '' }, fetching).translations();
    expect(asked).toEqual([]);
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.unavailable', status: 503, message: 'No scripture library is configured for this deployment.' },
    });
  });
});

describe('translating a refusal the library made', () => {
  const failure = (code: string, message: string): { status: number; body: unknown } => ({
    status: 400,
    body: { error: { code, message } },
  });

  it('answers a translated failure in this application own words', async () => {
    const { fetching } = answering([failure('unknown_translation', 'translation LOL is not in the registry')]);
    const result = await corpusClient(INTERNAL, fetching).translations();
    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'corpus.translation.unknown',
        status: 404,
        message: CORPUS_WORDING['corpus.translation.unknown'],
      },
    });
  });

  it('never repeats what the library said, whatever it said', async () => {
    const { fetching } = answering([failure('store_locked', 'the store at /data/holydeck/corpus is locked by job 91')]);
    const result = await corpusClient(INTERNAL, fetching).translations();
    expect(JSON.stringify(result)).not.toContain('/data');
    expect(JSON.stringify(result)).not.toContain('store_locked');
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.unavailable', status: 503, message: CORPUS_WORDING['corpus.unavailable'] },
    });
  });

  it('refuses to forward a failure the boundary decided is not the application to explain', async () => {
    for (const code of ['auth_failed', 'route_not_found', 'sermon_invalid']) {
      const { fetching } = answering([failure(code, 'something only the corpus can act on')]);
      const result = await corpusClient(INTERNAL, fetching).translations();
      expect(result, code).toEqual({
        ok: false,
        refusal: { code: 'corpus.unexpected_error', status: 500, message: CORPUS_WORDING['corpus.unexpected_error'] },
      });
    }
  });

  it('refuses a failure whose code it has never heard of, and one it cannot read', async () => {
    for (const body of [{ error: { code: 'invented_code', message: 'x' } }, { error: {} }, { nothing: true }]) {
      const { fetching } = answering([{ status: 500, body }]);
      const result = await corpusClient(INTERNAL, fetching).translations();
      expect(result).toEqual({
        ok: false,
        refusal: { code: 'corpus.unexpected_error', status: 500, message: CORPUS_WORDING['corpus.unexpected_error'] },
      });
    }
  });
});

describe('the words a client is given for a library failure', () => {
  const codes = MESSAGE_CODES.filter((entry) => entry.code.startsWith('corpus.'));

  it('has wording for every corpus code the contract publishes, and no others', () => {
    expect(Object.keys(CORPUS_WORDING).sort()).toEqual(codes.map((entry) => entry.code).sort());
  });

  it('gives each refusal it makes on its own the status the contract publishes for that code', () => {
    for (const refusal of [LIBRARY_UNAVAILABLE, LIBRARY_UNEXPECTED, LIBRARY_NOT_CONFIGURED]) {
      expect(MESSAGE_CODES.find((entry) => entry.code === refusal.code)?.status, refusal.code).toBe(refusal.status);
    }
  });

  it('says what happened without naming anything behind the boundary', () => {
    for (const [code, wording] of Object.entries(CORPUS_WORDING)) {
      expect(wording, code).toMatch(/^[A-Z].*\.$/u);
      expect(wording.toLowerCase(), code).not.toContain('corpus');
      expect(wording, code).not.toContain(code);
    }
  });
});

describe('proving the library is closed to anyone without a credential', () => {
  it('asks for a released route with no credential at all', async () => {
    const { fetching, asked } = answering([{ status: 401, body: {} }]);
    const probe = await probeCorpusIsClosed(INTERNAL, fetching);
    expect(asked).toEqual([{ url: 'http://corpus:8080/api/v1/translations', headers: {} }]);
    expect(probe).toEqual({ reached: true, closed: true, detail: 'http://corpus:8080 refused an unauthenticated request' });
    expect(corpusProbeProblems(probe)).toEqual([]);
  });

  it('refuses to run against a library that answers anyone', async () => {
    const probe = await probeCorpusIsClosed(INTERNAL, answering([{ status: 200, body: { translations } }]).fetching);
    expect(probe.closed).toBe(false);
    expect(corpusProbeProblems(probe)).toEqual([
      'http://corpus:8080 answered an unauthenticated request with 200; the internal API must require a credential',
    ]);
  });

  it('does not hold up a start-up because the library is not up yet', async () => {
    const probe = await probeCorpusIsClosed(INTERNAL, unreachable);
    expect(probe).toEqual({ reached: false, closed: false, detail: 'http://corpus:8080 could not be reached' });
    expect(corpusProbeProblems(probe)).toEqual([]);
  });

  it('has nothing to prove when no library is configured', async () => {
    const { fetching, asked } = answering([]);
    const probe = await probeCorpusIsClosed({ url: '', token: '' }, fetching);
    expect(asked).toEqual([]);
    expect(probe).toEqual({ reached: false, closed: false, detail: 'no library is configured' });
    expect(corpusProbeProblems(probe)).toEqual([]);
  });
});
