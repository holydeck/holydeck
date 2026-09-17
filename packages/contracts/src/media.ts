import { FIELD_CODES, type FieldReader, type ParseFn, parseObject } from './problems.js';

export const MEDIA_PROCESSING_STATES = ['pending', 'processing', 'ready', 'failed'] as const;

export type MediaProcessingState = (typeof MEDIA_PROCESSING_STATES)[number];

export interface MediaDerivative {
  readonly kind: string;
  readonly bytes: number;
  readonly hash: string;
  readonly from: string;
}

export interface MediaManifestEntry {
  readonly id: string;
  readonly bytes: number;
  readonly hash: string;
  readonly type: string;
  readonly processingState: MediaProcessingState;
  readonly derivatives: readonly MediaDerivative[];
}

const parseDerivative: ParseFn<MediaDerivative> = (value, path) =>
  parseObject(value, path, (reader: FieldReader) => ({
    kind: reader.text('kind'),
    bytes: reader.wholeNumber('bytes'),
    hash: reader.text('hash'),
    from: reader.text('from'),
  }));

/** Reads an entry in the media manifest that workers and the application share. */
export const parseMediaManifestEntry: ParseFn<MediaManifestEntry> = (value, path = 'media') =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const bytes = reader.wholeNumber('bytes');
    const hash = reader.text('hash');
    const type = reader.text('type');
    const processingState = reader.choice('processingState', MEDIA_PROCESSING_STATES);
    const derivatives = reader.parsedList('derivatives', parseDerivative);
    if (processingState === 'ready' && derivatives.length === 0) {
      reader.reject('derivatives', FIELD_CODES.notAllowed, 'must not be empty when processing is ready');
    }
    return {
      id,
      bytes,
      hash,
      type,
      processingState,
      derivatives,
    };
  });

const matches = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((value, index) => bytes[offset + index] === value);

/** The v1 formats accepted from their leading bytes, never a supplied name or media type. */
export const MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'font/woff2',
  'font/ttf',
  'font/otf',
] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

export function sniffMediaType(bytes: Uint8Array): MediaType | undefined {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (matches(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  if (matches(bytes, [0x77, 0x4f, 0x46, 0x32])) return 'font/woff2';
  if (matches(bytes, [0x00, 0x01, 0x00, 0x00])) return 'font/ttf';
  if (matches(bytes, [0x4f, 0x54, 0x54, 0x4f])) return 'font/otf';
  return undefined;
}
