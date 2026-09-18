import { MESSAGE_CODES } from '@holydeck/contracts/http';
import { corpusBoundaryProblems } from '@holydeck/contracts/corpus';
import { describe, expect, it } from 'vitest';

import {
  CORPUS_WORDING,
  LIBRARY_NOT_CONFIGURED,
  LIBRARY_UNAVAILABLE,
  LIBRARY_UNEXPECTED,
  REFERENCE_MALFORMED,
  REFERENCE_NOT_FOUND,
  applyOffset,
  corpusBinding,
  corpusBoundaryFor,
  corpusClient,
  corpusProbeProblems,
  probeCorpusIsClosed,
  searchScripture,
  selectReference,
  stackReferences,
} from './corpus.js';

import type { CorpusSearchHit } from '@holydeck/contracts/corpus';
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

const canon = {
  translation: 'KJV',
  source: 'bundled' as const,
  books: [
    { usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: '1', label: '1' }, { id: '2', label: '2' }] },
  ],
};

const verses = {
  verses: { '1': 'In the beginning God created the heaven and the earth.' },
  citation: 'Genesis 1:1 (KJV)',
  revision: 3,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache' as const,
};

describe('asking the library for a canon', () => {
  it('asks the released route for the translation asked about', async () => {
    const { fetching, asked } = answering([{ status: 200, body: canon }]);
    const result = await corpusClient(INTERNAL, fetching).canon('KJV');
    expect(asked).toEqual([{ url: 'http://corpus:8080/api/v1/translations/KJV/canon', headers: { authorization: `Bearer ${TOKEN}` } }]);
    expect(result).toEqual({ ok: true, value: canon });
  });

  it('refuses a canon it cannot read', async () => {
    const { fetching } = answering([{ status: 200, body: { translation: 'KJV', source: 'bundled', books: 'nope' } }]);
    const result = await corpusClient(INTERNAL, fetching).canon('KJV');
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.unexpected_error', status: 500, message: CORPUS_WORDING['corpus.unexpected_error'] },
    });
  });
});

describe('asking the library for verses', () => {
  it('asks the released route with the reference and revision it was given', async () => {
    const { fetching, asked } = answering([{ status: 200, body: verses }]);
    const result = await corpusClient(INTERNAL, fetching).verses('KJV', 'GEN', 1, [1, 2, 3], 3);
    expect(asked).toEqual([{
      url: 'http://corpus:8080/api/v1/translations/KJV/verses?book=GEN&chapter=1&verses=1%2C2%2C3&revision=3',
      headers: { authorization: `Bearer ${TOKEN}` },
    }]);
    expect(result).toEqual({ ok: true, value: verses });
  });

  it('asks for the latest revision when none is given', async () => {
    const { fetching, asked } = answering([{ status: 200, body: verses }]);
    await corpusClient(INTERNAL, fetching).verses('KJV', 'GEN', 1, [1]);
    expect(asked[0]?.url).toBe('http://corpus:8080/api/v1/translations/KJV/verses?book=GEN&chapter=1&verses=1');
  });

  it('surfaces the corpus own refusal for a verse outside the chapter, as a named error', async () => {
    const { fetching } = answering([{
      status: 404,
      body: { error: { code: 'verse_not_in_store', message: 'GEN 1:99 is not in the store' } },
    }]);
    const result = await corpusClient(INTERNAL, fetching).verses('KJV', 'GEN', 1, [99]);
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'corpus.reference.not_found', status: 404, message: CORPUS_WORDING['corpus.reference.not_found'] },
    });
  });
});

describe('selecting one validated reference', () => {
  it('reads the canon, confirms the reference is in it, and records the revision the verses came back at', async () => {
    const { fetching, asked } = answering([{ status: 200, body: canon }, { status: 200, body: verses }]);
    const client = corpusClient(INTERNAL, fetching);
    const result = await selectReference(client, { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] });
    expect(asked.map((call) => call.url)).toEqual([
      'http://corpus:8080/api/v1/translations/KJV/canon',
      'http://corpus:8080/api/v1/translations/KJV/verses?book=GEN&chapter=1&verses=1',
    ]);
    expect(result).toEqual({ ok: true, value: verses });
    expect(result.ok && result.value.revision).toBe(3);
  });

  it('rejects a book the canon does not hold, without asking for verses at all', async () => {
    const { fetching, asked } = answering([{ status: 200, body: canon }]);
    const client = corpusClient(INTERNAL, fetching);
    const result = await selectReference(client, { abbr: 'KJV', book: 'ZZZ', chapter: 1, verses: [1] });
    expect(asked).toHaveLength(1);
    expect(result).toEqual({ ok: false, refusal: REFERENCE_NOT_FOUND });
  });

  it('rejects a chapter the book does not hold, without asking for verses at all', async () => {
    const { fetching, asked } = answering([{ status: 200, body: canon }]);
    const client = corpusClient(INTERNAL, fetching);
    const result = await selectReference(client, { abbr: 'KJV', book: 'GEN', chapter: 99, verses: [1] });
    expect(asked).toHaveLength(1);
    expect(result).toEqual({ ok: false, refusal: REFERENCE_NOT_FOUND });
  });

  it('forwards the canon refusal when the library itself cannot be reached', async () => {
    const result = await selectReference(corpusClient(INTERNAL, unreachable), {
      abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1],
    });
    expect(result).toEqual({ ok: false, refusal: LIBRARY_UNAVAILABLE });
  });
});

const secondCanon = {
  translation: 'WEB',
  source: 'bundled' as const,
  books: [
    { usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: '1', label: '1' }, { id: '2', label: '2' }] },
  ],
};

const secondVerses = {
  verses: { '1': 'In the beginning, God created the heavens and the earth.' },
  citation: 'Genesis 1:1 (WEB)',
  revision: 1,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache' as const,
};

describe('stacking several translations for comparison', () => {
  const noOffset = { get: async (): Promise<number> => 0 };

  it('shifts the chapter by the offset, or leaves the reference untouched when the offset is zero', () => {
    const selection = { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] };
    expect(applyOffset(selection, 1)).toEqual({ ...selection, chapter: 2 });
    expect(applyOffset(selection, -1)).toEqual({ ...selection, chapter: 0 });
    expect(applyOffset(selection, 0)).toEqual(selection);
    expect(applyOffset(selection, 0)).toBe(selection);
  });

  it('answers one result per selection, in the order they were stacked and never resorted', async () => {
    const { fetching } = answering([
      { status: 200, body: secondCanon },
      { status: 200, body: secondVerses },
      { status: 200, body: canon },
      { status: 200, body: verses },
    ]);
    const client = corpusClient(INTERNAL, fetching);
    const stack = await stackReferences(client, noOffset, [
      { abbr: 'WEB', book: 'GEN', chapter: 1, verses: [1] },
      { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] },
    ]);
    expect(stack).toEqual([{ ok: true, value: secondVerses }, { ok: true, value: verses }]);
  });

  it('applies a translation own configured offset to the chapter before asking the library for it', async () => {
    const shifted = { ...verses, citation: 'Genesis 2:1 (KJV)' };
    const { fetching, asked } = answering([{ status: 200, body: canon }, { status: 200, body: shifted }]);
    const client = corpusClient(INTERNAL, fetching);
    const offsetByOne = { get: async (abbr: string): Promise<number> => (abbr === 'KJV' ? 1 : 0) };
    const stack = await stackReferences(client, offsetByOne, [{ abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] }]);
    expect(asked[1]?.url).toContain('chapter=2');
    expect(stack).toEqual([{ ok: true, value: shifted }]);
  });

  it('rejects an offset that walks a reference out of canon before the library is asked, without losing the rest of the stack', async () => {
    const { fetching, asked } = answering([
      { status: 200, body: canon },
      { status: 200, body: secondCanon },
      { status: 200, body: secondVerses },
    ]);
    const client = corpusClient(INTERNAL, fetching);
    const offsetOutOfCanon = { get: async (abbr: string): Promise<number> => (abbr === 'KJV' ? 5 : 0) };
    const stack = await stackReferences(client, offsetOutOfCanon, [
      { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] },
      { abbr: 'WEB', book: 'GEN', chapter: 1, verses: [1] },
    ]);
    expect(stack).toEqual([{ ok: false, refusal: REFERENCE_NOT_FOUND }, { ok: true, value: secondVerses }]);
    expect(asked.map((call) => call.url)).toEqual([
      'http://corpus:8080/api/v1/translations/KJV/canon',
      'http://corpus:8080/api/v1/translations/WEB/canon',
      'http://corpus:8080/api/v1/translations/WEB/verses?book=GEN&chapter=1&verses=1',
    ]);
  });
});

const cachedTranslations = [
  { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
  { abbreviation: 'WEB', id: 2, title: 'World English Bible', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
  { abbreviation: 'NIV', id: 3, title: 'New International Version', language: 'English', syncedChapters: 0, canonChapters: 1189, cached: false },
];

const hit = (fields: Partial<CorpusSearchHit> = {}): CorpusSearchHit => ({
  book: 'GEN',
  bookOrder: 0,
  chapter: 1,
  verse: 1,
  text: 'In the beginning God created the heaven and the earth.',
  revision: 3,
  phrase: true,
  occurrences: 1,
  ...fields,
});

const kjvHits = {
  translation: 'KJV',
  query: 'in the beginning',
  hits: [hit(), hit({ book: 'PSA', bookOrder: 18, chapter: 117, verse: 1, text: 'Praise him, all ye people.', phrase: false, occurrences: 2 })],
};

const webHits = {
  translation: 'WEB',
  query: 'in the beginning',
  hits: [hit({ text: 'In the beginning, God created the heavens and the earth.', revision: 1 })],
};

/** Counts what the search actually asked the library for, by translation, not merely which URLs it hit. */
function watching(client: ReturnType<typeof corpusClient>): {
  calls: string[];
  client: ReturnType<typeof corpusClient>;
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      translations: () => {
        calls.push('translations');
        return client.translations();
      },
      canon: (abbr) => {
        calls.push(`canon ${abbr}`);
        return client.canon(abbr);
      },
      verses: (abbr, book, chapter, verses, revision) => {
        calls.push(`verses ${abbr}`);
        return client.verses(abbr, book, chapter, verses, revision);
      },
      search: (abbr, query) => {
        calls.push(`search ${abbr}`);
        return client.search(abbr, query);
      },
    },
  };
}

describe('searching the scripture this deployment holds', () => {
  it('asks the released route for one translation, with the words it was given', async () => {
    const { fetching, asked } = answering([{ status: 200, body: kjvHits }]);
    const result = await corpusClient(INTERNAL, fetching).search('KJV', 'in the beginning');
    expect(asked).toEqual([{
      url: 'http://corpus:8080/api/v1/translations/KJV/search?q=in+the+beginning',
      headers: { authorization: `Bearer ${TOKEN}` },
    }]);
    expect(result).toEqual({ ok: true, value: kjvHits });
  });

  it('refuses search results it cannot read', async () => {
    const { fetching } = answering([{ status: 200, body: { translation: 'KJV', query: 'x', hits: 'none' } }]);
    const result = await corpusClient(INTERNAL, fetching).search('KJV', 'x');
    expect(result).toEqual({ ok: false, refusal: LIBRARY_UNEXPECTED });
  });

  it('searches every translation held locally, and never asks the library about one that is not', async () => {
    const { fetching, asked } = answering([
      { status: 200, body: { translations: cachedTranslations } },
      { status: 200, body: kjvHits },
      { status: 200, body: webHits },
    ]);
    const watched = watching(corpusClient(INTERNAL, fetching));
    const result = await searchScripture(watched.client, 'in the beginning');
    expect(watched.calls).toEqual(['translations', 'search KJV', 'search WEB']);
    expect(watched.calls.filter((call) => call.includes('NIV'))).toEqual([]);
    expect(asked.map((call) => call.url).join(' ')).not.toContain('NIV');
    expect(result.ok && result.value.map((match) => match.reference.abbr)).toEqual(['KJV', 'WEB', 'KJV']);
  });

  it('asks the library nothing at all for a query that names nothing', async () => {
    const { fetching, asked } = answering([]);
    const watched = watching(corpusClient(INTERNAL, fetching));
    for (const query of ['', '   ']) {
      const result = await searchScripture(watched.client, query);
      expect(result).toEqual({ ok: true, value: [] });
    }
    expect(watched.calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('opens a matching passage at the reference it was found at', async () => {
    const { fetching, asked } = answering([
      { status: 200, body: { translations: cachedTranslations } },
      { status: 200, body: kjvHits },
      { status: 200, body: webHits },
      { status: 200, body: canon },
      { status: 200, body: verses },
    ]);
    const client = corpusClient(INTERNAL, fetching);
    const found = await searchScripture(client, 'in the beginning');
    const first = found.ok ? found.value[0] : undefined;
    expect(first?.reference).toEqual({ abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1], revision: 3 });
    const opened = await selectReference(client, first?.reference ?? { abbr: '', book: '', chapter: 0, verses: [] });
    expect(asked.at(-1)?.url).toBe('http://corpus:8080/api/v1/translations/KJV/verses?book=GEN&chapter=1&verses=1&revision=3');
    expect(opened).toEqual({ ok: true, value: verses });
  });

  it('ranks identical input identically, whatever order the library answered in', async () => {
    const order = async (translations: typeof cachedTranslations, hits: readonly CorpusSearchHit[]) => {
      const { fetching } = answering([
        { status: 200, body: { translations } },
        { status: 200, body: { ...kjvHits, hits } },
        { status: 200, body: webHits },
      ]);
      const result = await searchScripture(corpusClient(INTERNAL, fetching), 'in the beginning');
      return result.ok ? result.value.map((match) => `${match.reference.abbr} ${match.reference.book} ${match.reference.chapter}:${match.reference.verses.join(',')}`) : result;
    };
    const ranked = await order(cachedTranslations, kjvHits.hits);
    expect(ranked).toEqual(['KJV GEN 1:1', 'WEB GEN 1:1', 'KJV PSA 117:1']);
    expect(await order([...cachedTranslations].reverse(), [...kjvHits.hits].reverse())).toEqual(ranked);
  });

  it('refuses the whole search when a translation it holds cannot be searched, rather than answering short', async () => {
    const { fetching } = answering([
      { status: 200, body: { translations: cachedTranslations } },
      { status: 200, body: kjvHits },
      { status: 503, body: { error: { code: 'store_locked', message: 'the store is locked by job 91' } } },
    ]);
    const result = await searchScripture(corpusClient(INTERNAL, fetching), 'in the beginning');
    expect(result).toEqual({ ok: false, refusal: LIBRARY_UNAVAILABLE });
  });

  it('forwards the refusal when the library cannot say which translations it holds', async () => {
    const result = await searchScripture(corpusClient(INTERNAL, unreachable), 'in the beginning');
    expect(result).toEqual({ ok: false, refusal: LIBRARY_UNAVAILABLE });
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
    for (const refusal of [LIBRARY_UNAVAILABLE, LIBRARY_UNEXPECTED, LIBRARY_NOT_CONFIGURED, REFERENCE_NOT_FOUND, REFERENCE_MALFORMED]) {
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
