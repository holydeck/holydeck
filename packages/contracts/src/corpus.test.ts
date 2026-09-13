import { describe, expect, it } from 'vitest';

import {
  CORPUS_AUTH_HEADER,
  CORPUS_AUTH_SCHEME,
  CORPUS_CLIENT,
  CORPUS_ERRORS_NOT_FORWARDED,
  CORPUS_ERROR_MAPPING,
  CORPUS_ROUTES,
  CORPUS_UNEXPECTED,
  CORPUS_UNEXPECTED_STATUS,
  corpusAuthorization,
  corpusBoundary,
  corpusBoundaryProblems,
  corpusFailureMapping,
  corpusTokenMatches,
  parseCorpusFailure,
  parseCorpusTranslations,
  presentedCorpusToken,
} from './corpus.js';
import { statusForCode } from './http.js';

const STABLE_CODE = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

describe('the credential the internal corpus port accepts', () => {
  it('builds a bearer header and reads the token back out of it', () => {
    expect(CORPUS_AUTH_HEADER).toBe('authorization');
    expect(CORPUS_AUTH_SCHEME).toBe('Bearer');
    expect(corpusAuthorization('s3cret')).toBe('Bearer s3cret');
    expect(presentedCorpusToken(corpusAuthorization('s3cret'))).toBe('s3cret');
  });

  it('reads the scheme in whichever case and spacing the corpus receives it', () => {
    expect(presentedCorpusToken('bearer s3cret')).toBe('s3cret');
    expect(presentedCorpusToken('  BEARER   s3cret  ')).toBe('s3cret');
    expect(presentedCorpusToken(['Bearer s3cret'])).toBe('s3cret');
  });

  it('reads nothing from a header that is not one bearer credential', () => {
    for (const header of [undefined, '', 'Basic s3cret', 'Bearer', 'Bearer    ', 7, [], ['Token s3cret'],
      'Bearer a, Bearer b']) {
      expect(presentedCorpusToken(header)).toBeUndefined();
    }
  });

  it('matches the configured token and refuses everything else, including nothing', () => {
    expect(corpusTokenMatches('s3cret', 's3cret')).toBe(true);
    expect(corpusTokenMatches('s3crat', 's3cret')).toBe(false);
    expect(corpusTokenMatches('s3cre', 's3cret')).toBe(false);
    expect(corpusTokenMatches('s3crett', 's3cret')).toBe(false);
    expect(corpusTokenMatches(undefined, 's3cret')).toBe(false);
  });

  it('matches nothing at all when no token is configured, because an open internal port is the fault', () => {
    expect(corpusTokenMatches('', '')).toBe(false);
    expect(corpusTokenMatches('anything', '')).toBe(false);
  });
});

describe('a corpus failure', () => {
  it('reads the envelope the corpus sends', () => {
    const parsed = parseCorpusFailure({ error: { code: 'unknown_translation', message: 'No such translation.' } });
    expect(parsed.ok && parsed.value).toEqual({ code: 'unknown_translation', message: 'No such translation.' });
  });

  it('reads the envelope even when the corpus adds to it, such as the route directory of a 404', () => {
    const parsed = parseCorpusFailure({
      error: { code: 'route_not_found', message: 'GET /nope is not a route.' },
      endpoints: { 'GET /health': 'liveness' },
    });
    expect(parsed.ok && parsed.value).toEqual({ code: 'route_not_found', message: 'GET /nope is not a route.' });
  });

  it('refuses a body that is not an envelope', () => {
    const parsed = parseCorpusFailure('nope');
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'corpusFailure', code: 'field.not_an_object', message: 'must be an object' },
    ]);
  });

  it('refuses an envelope with no error, and names every field it could not read at once', () => {
    const empty = parseCorpusFailure({});
    expect(empty.ok === false && empty.problems).toEqual([
      { path: 'corpusFailure.error', code: 'field.required', message: 'is required' },
    ]);
    const parsed = parseCorpusFailure({ error: { code: 7 } });
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'corpusFailure.error.code', code: 'field.not_text', message: 'must be text' },
      { path: 'corpusFailure.error.message', code: 'field.required', message: 'is required' },
    ]);
  });
});

describe('the translations the application reads through the boundary', () => {
  const body = () => ({
    translations: [
      { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English',
        syncedChapters: 1189, canonChapters: 1189, cached: true },
    ],
  });

  it('reads the list the corpus returns', () => {
    const parsed = parseCorpusTranslations(body());
    expect(parsed.ok && parsed.value).toEqual(body().translations);
  });

  it('reads a translation the corpus has recorded no language for, because nothing is cached yet', () => {
    const value = body();
    delete (value.translations[0] as { language?: string }).language;
    const parsed = parseCorpusTranslations(value);
    expect(parsed.ok && parsed.value[0]?.language).toBe('');
  });

  it('refuses a body that is not a list of translations', () => {
    const parsed = parseCorpusTranslations({ translations: 'KJV' });
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'corpusTranslations.translations', code: 'field.not_a_list', message: 'must be a list' },
    ]);
  });

  it('refuses a translation with nothing to name it by', () => {
    const value = body();
    delete (value.translations[0] as { abbreviation?: string }).abbreviation;
    const parsed = parseCorpusTranslations(value);
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'corpusTranslations.translations.0.abbreviation', code: 'field.required', message: 'is required' },
    ]);
  });
});

describe('the error mapping the boundary is built from', () => {
  it('maps every corpus error to a released application code carrying its released status', () => {
    for (const entry of CORPUS_ERROR_MAPPING) {
      expect(entry.code, entry.corpus).toMatch(STABLE_CODE);
      expect(statusForCode(entry.code), entry.code).toBe(entry.http);
    }
  });

  it('refuses an untranslated failure with a released code of its own', () => {
    expect(CORPUS_UNEXPECTED).toBe('corpus.unexpected_error');
    expect(statusForCode(CORPUS_UNEXPECTED)).toBe(CORPUS_UNEXPECTED_STATUS);
  });

  it('names each corpus error once, and never both maps and refuses one', () => {
    const mapped = CORPUS_ERROR_MAPPING.map((entry) => entry.corpus);
    const refused = CORPUS_ERRORS_NOT_FORWARDED.map((entry) => entry.corpus);
    expect(new Set([...mapped, ...refused]).size).toBe(mapped.length + refused.length);
  });

  it('translates the corpus errors the application can act on', () => {
    expect(corpusFailureMapping('unknown_translation')).toEqual({
      corpus: 'unknown_translation', http: 404, code: 'corpus.translation.unknown',
    });
    expect(corpusFailureMapping('verse_not_in_store')?.code).toBe('corpus.reference.not_found');
    expect(corpusFailureMapping('scrape_blocked')?.code).toBe('corpus.upstream.unavailable');
  });

  it('translates nothing it has not decided about, so an untranslated error cannot be forwarded', () => {
    expect(corpusFailureMapping('sermon_invalid')).toBeUndefined();
    expect(corpusFailureMapping('a_code_from_a_later_release')).toBeUndefined();
  });

  it('records why each corpus error it does not translate is not translated', () => {
    expect(CORPUS_ERRORS_NOT_FORWARDED.length).toBeGreaterThan(0);
    for (const entry of CORPUS_ERRORS_NOT_FORWARDED) {
      expect(entry.reason.trim(), entry.corpus).not.toBe('');
    }
  });
});

// The recording in contracts/fixtures/corpus-boundary.v1.json, which is what AC-corpus-1 is graded
// against. It is written out here rather than imported, because the product repository holds no phase
// artifacts; the counterexamples below are the fixture's own defects, one deliberate defect each.
const packet = () => ({
  client: { typed: true, generatedFrom: 'contracts/corpus-boundary.schema.json', language: 'TypeScript' },
  port: { binding: 'loopback', publiclyRoutable: false, authenticated: true },
  errorMapping: [
    { corpus: 'ReferenceNotFound', http: 404, code: 'corpus.reference.not_found' },
    { corpus: 'TranslationNotLicensed', http: 403, code: 'corpus.translation.not_licensed' },
    { corpus: 'CorpusUnavailable', http: 503, code: 'corpus.unavailable' },
    { corpus: 'MalformedReference', http: 422, code: 'corpus.reference.malformed' },
  ],
  releasedRoutes: [
    { route: '/v1/passages', preserved: true, since: '2026-04-01' },
    { route: '/v1/translations', preserved: true, since: '2026-04-01' },
  ],
});

describe('the boundary itself', () => {
  it('accepts the recording the contract was written from', () => {
    expect(corpusBoundaryProblems(packet())).toEqual([]);
  });

  const refuses = (name: string, defect: (value: ReturnType<typeof packet>) => void, diagnostics: readonly string[]) => {
    it(`refuses ${name}`, () => {
      const value = packet();
      defect(value);
      expect(corpusBoundaryProblems(value)).toEqual(diagnostics);
    });
  };

  refuses('an untyped corpus client', (value) => {
    value.client.typed = false;
  }, ['corpus client: is not typed']);

  refuses('a client generated from nothing', (value) => {
    delete (value.client as { generatedFrom?: string }).generatedFrom;
  }, ['corpus client: names no schema it is generated from']);

  refuses('a publicly routable internal port', (value) => {
    value.port.publiclyRoutable = true;
  }, ['corpus port: is publicly routable']);

  refuses('an externally bound port', (value) => {
    value.port.binding = '0.0.0.0';
  }, ['corpus port: binding 0.0.0.0 is not internal']);

  refuses('a port with no binding recorded at all', (value) => {
    delete (value.port as { binding?: string }).binding;
  }, ['corpus port: binding undefined is not internal']);

  refuses('an unauthenticated internal port', (value) => {
    value.port.authenticated = false;
  }, ['corpus port: is unauthenticated']);

  refuses('a corpus error mapped to a success status', (value) => {
    value.errorMapping[0] = { ...value.errorMapping[0]!, http: 200 };
  }, ['error mapping ReferenceNotFound: maps to 200, which is not a client or server status']);

  refuses('a corpus error mapped past the statuses a server can answer with', (value) => {
    value.errorMapping[0] = { ...value.errorMapping[0]!, http: 600 };
  }, ['error mapping ReferenceNotFound: maps to 600, which is not a client or server status']);

  refuses('a corpus error mapped to an unstable code', (value) => {
    value.errorMapping[1] = { ...value.errorMapping[1]!, code: 'Not Licensed' };
  }, ['error mapping TranslationNotLicensed: Not Licensed is not a stable message code']);

  refuses('a released route dropped', (value) => {
    value.releasedRoutes[0] = { ...value.releasedRoutes[0]!, preserved: false };
  }, ['released route /v1/passages: was not preserved']);

  refuses('no error mapping at all', (value) => {
    value.errorMapping = [];
  }, ['corpus boundary: no error mapping']);

  refuses('no released routes recorded', (value) => {
    value.releasedRoutes = [];
  }, ['corpus boundary: no released routes recorded']);

  refuses('a mapping and a route list recorded as something other than lists', (value) => {
    value.errorMapping = {} as unknown as typeof value.errorMapping;
    value.releasedRoutes = 'GET /v1/passages' as unknown as typeof value.releasedRoutes;
  }, ['corpus boundary: no error mapping', 'corpus boundary: no released routes recorded']);

  refuses('an error mapping entry naming no corpus error', (value) => {
    value.errorMapping[0] = { corpus: '', http: 404, code: 'corpus.reference.not_found' };
  }, ['error mapping: names no corpus error']);

  refuses('an entry that is not an entry, without hiding the rest of the mapping behind it', (value) => {
    value.errorMapping.push(null as unknown as (typeof value.errorMapping)[number]);
  }, [
    'error mapping: names no corpus error',
    'error mapping ?: maps to undefined, which is not a client or server status',
    'error mapping ?: undefined is not a stable message code',
  ]);

  refuses('a route that is not a route', (value) => {
    value.releasedRoutes.push(null as unknown as (typeof value.releasedRoutes)[number]);
  }, ['released route undefined: was not preserved']);

  it('refuses a packet that is not a packet', () => {
    expect(corpusBoundaryProblems('nothing')).toEqual(['corpus boundary: must be an object']);
  });

  it('grades the boundary this build actually presents, so the contract is checked against the product', () => {
    expect(CORPUS_CLIENT.typed).toBe(true);
    expect(CORPUS_ROUTES.length).toBeGreaterThan(0);
    expect(corpusBoundaryProblems(corpusBoundary({
      binding: 'loopback', publiclyRoutable: false, authenticated: true,
    }))).toEqual([]);
    expect(corpusBoundaryProblems(corpusBoundary({
      binding: 'internal-network', publiclyRoutable: false, authenticated: true,
    }))).toEqual([]);
  });

  it('refuses the boundary a deployment would present if it published the corpus port', () => {
    expect(corpusBoundaryProblems(corpusBoundary({
      binding: '0.0.0.0', publiclyRoutable: true, authenticated: false,
    }))).toEqual([
      'corpus port: is publicly routable',
      'corpus port: binding 0.0.0.0 is not internal',
      'corpus port: is unauthenticated',
    ]);
  });
});
