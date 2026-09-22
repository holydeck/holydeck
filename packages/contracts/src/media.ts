import { FIELD_CODES, type FieldReader, type Parsed, type ParseFn, parseObject } from './problems.js';

export type MediaStatus = { readonly archived: boolean };

export function parseMediaStatus(value: unknown): Parsed<MediaStatus> {
  return parseObject(value, 'media', (reader) => ({ archived: reader.flag('archived') }));
}

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

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const byteAt = (bytes: Uint8Array, offset: number): number => bytes[offset] ?? 0;

const uint32BE = (bytes: Uint8Array, offset: number): number =>
  ((byteAt(bytes, offset) << 24) |
    (byteAt(bytes, offset + 1) << 16) |
    (byteAt(bytes, offset + 2) << 8) |
    byteAt(bytes, offset + 3)) >>>
  0;

const uint16BE = (bytes: Uint8Array, offset: number): number => (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);

const uint16LE = (bytes: Uint8Array, offset: number): number => byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);

const uint24LE = (bytes: Uint8Array, offset: number): number =>
  byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16);

// The IHDR chunk always opens a valid PNG's data, but `sniffMediaType` only checked the 8-byte file
// signature above it — this checks the chunk's own length and type before trusting what follows.
const pngDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  if (uint32BE(bytes, 8) !== 13 || !matches(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return undefined;
  return { width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) };
};

// The logical screen descriptor immediately after GIF's 6-byte signature. Nothing here cross-checks it,
// because GIF's header carries no length or type field the way PNG's chunk does.
const gifDimensions = (bytes: Uint8Array): ImageDimensions => ({
  width: uint16LE(bytes, 6),
  height: uint16LE(bytes, 8),
});

// WEBP nests one of three sub-formats behind the RIFF/WEBP signature `sniffMediaType` already checked,
// each with its own width/height encoding at its own offset within the first chunk's payload.
const webpDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  if (matches(bytes, [0x56, 0x50, 0x38, 0x58], 12) && bytes.length >= 30) {
    // VP8X (extended): three 24-bit little-endian fields, canvas width/height minus one.
    return { width: uint24LE(bytes, 24) + 1, height: uint24LE(bytes, 27) + 1 };
  }
  if (matches(bytes, [0x56, 0x50, 0x38, 0x20], 12) && bytes.length >= 30) {
    // VP8 (lossy): a 3-byte frame tag and 3-byte start code precede two 14-bit dimensions.
    return { width: uint16LE(bytes, 26) & 0x3fff, height: uint16LE(bytes, 28) & 0x3fff };
  }
  if (matches(bytes, [0x56, 0x50, 0x38, 0x4c], 12) && bytes.length >= 25) {
    // VP8L (lossless): a signature byte, then one bit-packed 32-bit little-endian value holding both
    // 14-bit dimensions minus one, an alpha bit and a 3-bit version, in that order from the low bit up.
    const bits = byteAt(bytes, 21) | (byteAt(bytes, 22) << 8) | (byteAt(bytes, 23) << 16) | (byteAt(bytes, 24) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
};

/** SOF markers that are not a frame header at all: DHT, JPG extension and DAC share the 0xC0-0xCF range. */
const NOT_A_FRAME_MARKER = new Set([0xc4, 0xc8, 0xcc]);

// Walks JPEG's marker segments from just past SOI until a start-of-frame marker gives up the pixel
// dimensions every one of them carries at the same offset — never a decode of the entropy-coded data
// that follows. Every branch below advances `offset`, so the loop always terminates.
const jpegDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = byteAt(bytes, offset + 1);
    // 0xFF fill bytes pad between markers and are skipped one at a time until a real marker byte shows.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOI, EOI, TEM and the eight restart markers carry no length field at all.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME_MARKER.has(marker)) {
      return { width: uint16BE(bytes, offset + 7), height: uint16BE(bytes, offset + 5) };
    }
    const length = uint16BE(bytes, offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
};

/**
 * The pixel dimensions a decoder would have to hold, read from the format's own header fields alone —
 * never a full decode, which is the resource THR-07 names as the thing a memory-exhaustion attack
 * spends. `undefined` for a type this reads no header for (video, font) and, deliberately, for an image
 * whose header this cannot make sense of: this codebase decodes no image anywhere today, so a
 * signature-matching-but-malformed file skipping the pixel-count check here is no worse off than a
 * codebase that never had the check at all.
 */
export function imageDimensionsOf(bytes: Uint8Array): ImageDimensions | undefined {
  switch (sniffMediaType(bytes)) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/gif':
      return gifDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    default:
      return undefined;
  }
}
