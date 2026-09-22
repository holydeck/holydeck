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

// Narrower than requireApiToken: also accepts a client token, scoped to whichever routes call this
// instead (the read/render routes the CLI reaches through the proxy). Sync, stats and search routes
// call requireApiToken directly and so never accept a client token, only the service token itself.
export function requireProxyToken(
  headers: Record<string, unknown>,
  expected: string,
  clientTokens: readonly string[] = [],
): void {
  const presented = presentedCorpusToken(headers[CORPUS_AUTH_HEADER]);
  if (corpusTokenMatches(presented, expected)) return;
  if (clientTokens.some((clientToken) => corpusTokenMatches(presented, clientToken))) return;
  throw new HolyDeckError('auth_failed', { reason: 'no matching bearer token was presented' });
}
