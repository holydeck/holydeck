// The dashboard has to show something the instant a service reopens, even before a fetch returns, and
// say plainly when it is showing yesterday's answer because the network is gone. This is that small
// cache: an in-memory copy for the common case, mirrored into sessionStorage so a reload during an
// outage still finds it. A private browsing context or a full quota must never stop the dashboard from
// rendering the answer it already holds in memory.

const CACHE_PREFIX = 'holydeck.cache.';

export type CachedAnswer = { readonly value: unknown; readonly at: string };

const memory = new Map<string, CachedAnswer>();

const isCachedAnswer = (value: unknown): value is CachedAnswer =>
  typeof value === 'object' &&
  value !== null &&
  'value' in value &&
  typeof (value as Record<string, unknown>)['at'] === 'string';

/** Remembers one answer under `key`, timestamped with `at` (now, unless a caller names another time). */
export function rememberAnswer(key: string, value: unknown, at: Date = new Date()): void {
  const entry: CachedAnswer = { value, at: at.toISOString() };
  memory.set(key, entry);
  try {
    globalThis.sessionStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
}

/** Reads one cached answer, treating absent, malformed or inaccessible storage as no cached answer. */
export function recallAnswer(key: string): CachedAnswer | undefined {
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = globalThis.sessionStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedAnswer(parsed)) return undefined;
    memory.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}
