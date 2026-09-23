import { FIELD_CODES, type Parsed, parseObject } from './problems.js';

export const SERMON_IMPORT_PREVIEW_PATH = '/api/v1/sermons/import/preview';

export interface SermonImportRequest {
  readonly text: string;
  readonly translations: readonly string[];
}

const TEXT_LIMIT = 20_000;

/** Reads the text and translation choices sent to the sermon import preview. */
export function parseSermonImportRequest(value: unknown): Parsed<SermonImportRequest> {
  return parseObject(value, 'sermonImport', (reader) => {
    const text = reader.text('text');
    if (text.length > TEXT_LIMIT) {
      reader.reject('text', FIELD_CODES.notAllowed, `must not exceed ${TEXT_LIMIT} characters`);
    }
    const translations = reader.textList('translations');
    if (translations.length === 0) {
      reader.reject('translations', FIELD_CODES.required, 'must contain at least one translation');
    }
    return { text, translations };
  });
}
