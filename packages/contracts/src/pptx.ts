import { FIELD_CODES, type Parsed, type ParseFn, parseObject } from './problems.js';
import { parseSongTitles, type SongTitles } from './songs.js';

export const PPTX_IMPORTS_PATH = '/api/v1/pptx-imports';

export interface PptxReviewDecisionInput {
  readonly slideIndex: number;
  readonly blockIndex: number;
  readonly label: string;
}

const parsePptxReviewDecision: ParseFn<PptxReviewDecisionInput> = (value, path) =>
  parseObject(value, path, (reader) => ({
    slideIndex: reader.wholeNumber('slideIndex'),
    blockIndex: reader.wholeNumber('blockIndex'),
    label: reader.text('label'),
  }));

/** Reads the decisions that give ambiguous PowerPoint blocks their catalogue labels. */
export function parsePptxReviewDecisions(value: unknown): Parsed<readonly PptxReviewDecisionInput[]> {
  if (!Array.isArray(value)) {
    return { ok: false, problems: [{ path: 'pptxReviewDecisions', code: FIELD_CODES.notAList, message: 'must be a list' }] };
  }
  const decisions: PptxReviewDecisionInput[] = [];
  const problems = [];
  for (const [index, item] of value.entries()) {
    const parsed = parsePptxReviewDecision(item, `pptxReviewDecisions.${index}`);
    if (parsed.ok) decisions.push(parsed.value);
    else problems.push(...parsed.problems);
  }
  return problems.length === 0 ? { ok: true, value: decisions } : { ok: false, problems };
}

export type PptxCommitTargetInput =
  | { readonly mode: 'create'; readonly title: SongTitles; readonly reference?: string }
  | { readonly mode: 'append'; readonly id: string };

const SONG_TITLES_FALLBACK: SongTitles = { tamil: '', romanized: '' };

/** Reads the existing-song or new-song target selected after reviewing a PowerPoint import. */
export function parsePptxCommitTarget(value: unknown): Parsed<PptxCommitTargetInput> {
  return parseObject(value, 'pptxCommitTarget', (reader) => {
    const mode = reader.choice('mode', ['create', 'append'] as const);
    if (mode === 'append') {
      reader.absent('title', FIELD_CODES.notAllowed, 'must not be set when appending');
      reader.absent('reference', FIELD_CODES.notAllowed, 'must not be set when appending');
      return { mode, id: reader.text('id') };
    }
    reader.absent('id', FIELD_CODES.notAllowed, 'must not be set when creating');
    const title = reader.parsed('title', parseSongTitles, SONG_TITLES_FALLBACK);
    const reference = reader.optionalText('reference');
    return { mode, title, ...(reference === undefined ? {} : { reference }) };
  });
}
