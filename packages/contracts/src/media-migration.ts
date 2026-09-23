// What an operator asks when moving media storage to a new root (OPS-16). See
// `apps/worker/src/media-migration-handler.ts` for what the move itself verifies.

import { FIELD_CODES, type Parsed, parseObject } from './problems.js';

export interface MediaMigrationRequest {
  readonly targetRoot: string;
}

const looksAbsolute = (value: string): boolean => value.startsWith('/') && value.trim() === value && value !== '/';

export function parseMediaMigrationRequest(value: unknown): Parsed<MediaMigrationRequest> {
  return parseObject(value, 'mediaMigration', (reader) => {
    const targetRoot = reader.text('targetRoot');
    if (targetRoot !== '' && !looksAbsolute(targetRoot)) {
      reader.reject('targetRoot', FIELD_CODES.notAllowed, 'must be an absolute filesystem path');
    }
    return { targetRoot };
  });
}
