// The one canonical form in this system: every object's keys sorted, every list left in the order it was
// written, and no whitespace anywhere. Two values that mean the same thing are the same text here, which
// is what lets a hash be an address (ADR 0001) and what makes an unchanged export the same bytes twice
// (SONG-01). Lists are deliberately not sorted: reordering stanzas changes a song.

import { isRecord } from './problems.js';

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) sorted[key] = canonical(value[key]);
  return sorted;
}

/**
 * The canonical text of a value. JSON has no way to write `undefined`, so a value JSON cannot carry
 * answers with nothing at all; a hash needs bytes, and `null` is the one thing JSON says nothing with.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}
