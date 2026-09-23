import { type Parsed, type ParseFn, parseObject } from './problems.js';

export const SERMONS_PATH = '/api/v1/sermons';

export type SermonGenerationRequest = {
  readonly sermonRevision: number;
  readonly slideLayoutId: string;
  readonly slideLayoutRevision: number;
  readonly slideGroupId?: string;
};

export const parseSermonGenerationRequest: ParseFn<SermonGenerationRequest> = (value, path = 'sermon'): Parsed<SermonGenerationRequest> =>
  parseObject(value, path, (reader) => {
    const sermonRevision = reader.wholeNumber('sermonRevision', 1);
    const slideLayoutId = reader.text('slideLayoutId');
    const slideLayoutRevision = reader.wholeNumber('slideLayoutRevision', 1);
    const slideGroupId = reader.optionalText('slideGroupId');
    return { sermonRevision, slideLayoutId, slideLayoutRevision, ...(slideGroupId === undefined ? {} : { slideGroupId }) };
  });
