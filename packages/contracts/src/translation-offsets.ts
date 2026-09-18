// The contract for a per-translation offset (spec BIBL-02): what one entry looks like, and how a list of
// them parses off the wire. An offset may be negative, so it is read with a floor rather than the default
// whole-number reading that would refuse anything under zero.

import { type Parsed, type ParseFn, parseObject } from './problems.js';

export const TRANSLATION_OFFSETS_PATH = '/api/v1/translation-offsets';

/** No translation drifts by more than this many chapters from where its own canon puts it. */
export const TRANSLATION_OFFSET_BOUND = 1_000;

export type TranslationOffsetEntry = {
  readonly abbr: string;
  readonly offset: number;
};

export const parseTranslationOffsetEntry: ParseFn<TranslationOffsetEntry> = (value, path) =>
  parseObject(value, path, (reader) => ({
    abbr: reader.text('abbr'),
    offset: reader.wholeNumber('offset', -TRANSLATION_OFFSET_BOUND),
  }));

export function parseTranslationOffsetList(
  value: unknown,
  path = 'translationOffsets',
): Parsed<readonly TranslationOffsetEntry[]> {
  return parseObject(value, path, (reader) => reader.parsedList('offsets', parseTranslationOffsetEntry));
}
