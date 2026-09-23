export type ByteRange =
  | { readonly kind: 'whole' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

/** Reads the single byte range this server supports, ignoring malformed or multiple ranges. */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined || header.includes(',')) return { kind: 'whole' };
  const matched = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (matched === null) return { kind: 'whole' };

  const [, first = '', last = ''] = matched;
  if (first === '' && last === '') return { kind: 'whole' };

  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return { kind: 'whole' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(first);
  if (!Number.isSafeInteger(start)) return { kind: 'whole' };
  if (last === '') {
    return start >= size ? { kind: 'unsatisfiable' } : { kind: 'partial', start, end: size - 1 };
  }

  const requestedEnd = Number(last);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return { kind: 'whole' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) };
}
