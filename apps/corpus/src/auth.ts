import { CORPUS_AUTH_HEADER, corpusTokenMatches, presentedCorpusToken } from '@holydeck/contracts/corpus';
import { HolyDeckError } from '@holydeck/core/messages';

/**
 * Refuses a request that did not present the configured token. The reason says only that no matching
 * token was presented: a refusal that describes what was wrong with the credential is a refusal that
 * helps the next attempt.
 */
export function requireApiToken(headers: Record<string, unknown>, expected: string): void {
  if (corpusTokenMatches(presentedCorpusToken(headers[CORPUS_AUTH_HEADER]), expected)) return;
  throw new HolyDeckError('auth_failed', { reason: 'no matching bearer token was presented' });
}
