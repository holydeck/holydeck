// Where the client asks to search the scripture this deployment already holds (BIBL-03) — separate
// from corpus.ts's own paths, because searching is client-facing and the corpus API is not.

import { FIELD_CODES, isRecord, type Parsed, type Problem } from './problems.js';

export const SCRIPTURE_SEARCH_PATH = '/api/v1/scripture/search';

/** Past this, a query is refused before anything is asked of the library, not merely truncated. */
export const SCRIPTURE_QUERY_MAX = 200;

export type ScriptureSearchQuery = { readonly q: string };

/**
 * Reads `?q=` off a query string. Absent or empty is not an error — it means "search nothing" — so
 * only a query that is present and too long is refused.
 */
export function parseScriptureSearchQuery(query: unknown, path = 'scriptureSearch'): Parsed<ScriptureSearchQuery> {
  const source = isRecord(query) ? query : {};
  const raw = source['q'];
  const q = typeof raw === 'string' ? raw : '';
  const problems: Problem[] = [];
  if (q.length > SCRIPTURE_QUERY_MAX) {
    problems.push({
      path: `${path}.q`,
      code: FIELD_CODES.tooLarge,
      message: `must be at most ${SCRIPTURE_QUERY_MAX} characters`,
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { q } };
}
