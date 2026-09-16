// A prepared render model is frozen because REND-01 makes it a promise, not a convention: the ratio and
// the margins are "frozen at preparation", and a surface that could reach in and change one would be a
// surface able to diverge from the other three without anybody noticing. Freezing turns that from a
// review comment into a TypeError.

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}
