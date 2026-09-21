import { describe, expect, it } from 'vitest';

import { MEDIA_PROCESSING_STATES, imageDimensionsOf, parseMediaManifestEntry, sniffMediaType } from './media.js';
import { FIELD_CODES } from './problems.js';

const entry = () => ({
  id: 'media-1',
  bytes: 12,
  hash: 'sha256:abc',
  type: 'image/png',
  processingState: 'pending',
  derivatives: [{ kind: 'thumbnail', bytes: 4, hash: 'sha256:def', from: 'media-1' }],
});

describe('media manifest entries', () => {
  it('reads every field the manifest contract requires', () => {
    expect(parseMediaManifestEntry(entry(), 'entry')).toEqual({ ok: true, value: entry() });
    expect(MEDIA_PROCESSING_STATES).toEqual(['pending', 'processing', 'ready', 'failed']);
  });

  it('rejects missing metadata and malformed derivatives', () => {
    const parsed = parseMediaManifestEntry({ ...entry(), bytes: -1, processingState: 'queued', derivatives: [{}] }, 'entry');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`)).toEqual([
      `entry.bytes=${FIELD_CODES.tooSmall}`,
      `entry.processingState=${FIELD_CODES.notAllowed}`,
      `entry.derivatives.0.kind=${FIELD_CODES.required}`,
      `entry.derivatives.0.bytes=${FIELD_CODES.required}`,
      `entry.derivatives.0.hash=${FIELD_CODES.required}`,
      `entry.derivatives.0.from=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a ready entry without the derivatives that made it ready', () => {
    const parsed = parseMediaManifestEntry({ ...entry(), processingState: 'ready', derivatives: [] }, 'entry');
    expect(parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`)).toEqual([
      `entry.derivatives=${FIELD_CODES.notAllowed}`,
    ]);
  });
});

describe('media content sniffing', () => {
  it('accepts a PNG by its bytes even when a client calls it text', () => {
    const pngNamedText = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(sniffMediaType(pngNamedText)).toBe('image/png');
  });

  it('rejects bytes outside the closed supported signature set', () => {
    expect(sniffMediaType(new TextEncoder().encode('not media'))).toBeUndefined();
  });

  it('recognises every supported format by its signature', () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffMediaType(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]))).toBe('video/mp4');
    expect(sniffMediaType(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe('font/woff2');
    expect(sniffMediaType(new Uint8Array([0, 1, 0, 0]))).toBe('font/ttf');
    expect(sniffMediaType(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe('font/otf');
  });
});

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const gif = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
};

const webpVp8x = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
};

const webpVp8 = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes.set([width & 0xff, (width >> 8) & 0xff], 26);
  bytes.set([height & 0xff, (height >> 8) & 0xff], 28);
  return bytes;
};

const webpVp8l = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(25);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
  bytes[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  bytes.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
  return bytes;
};

const jpeg = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(15);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  bytes.set([0x01, 0x01, 0x11, 0x00], 11);
  return bytes;
};

const jpegWithAppSegment = (width: number, height: number): Uint8Array => {
  const sof = jpeg(width, height).slice(2);
  const bytes = new Uint8Array(8 + sof.length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 0);
  bytes.set(sof, 8);
  return bytes;
};

describe('image dimension reading', () => {
  it('reads a PNG by its IHDR chunk, cross-checked by length and type', () => {
    expect(imageDimensionsOf(png(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('refuses a PNG signature whose IHDR chunk was tampered with', () => {
    const bytes = png(800, 600);
    bytes.set([0x00, 0x00, 0x00, 0x00], 12);
    expect(imageDimensionsOf(bytes)).toBeUndefined();
  });

  it('reads a GIF by its logical screen descriptor', () => {
    expect(imageDimensionsOf(gif(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('reads every WEBP sub-format by its own header shape', () => {
    expect(imageDimensionsOf(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensionsOf(webpVp8(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensionsOf(webpVp8l(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it('reads a JPEG by walking straight to its first start-of-frame marker', () => {
    expect(imageDimensionsOf(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('walks a JPEG past a marker segment that is not the frame header', () => {
    expect(imageDimensionsOf(jpegWithAppSegment(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('skips a fill byte padded in front of the real marker', () => {
    const base = jpeg(1280, 720);
    const padded = new Uint8Array(base.length + 1);
    padded.set(base.subarray(0, 2), 0);
    padded[2] = 0xff;
    padded.set(base.subarray(2), 3);
    expect(imageDimensionsOf(padded)).toEqual({ width: 1280, height: 720 });
  });

  it('gives up on a JPEG that never reaches a start-of-frame marker', () => {
    expect(imageDimensionsOf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
  });

  it('reads no dimensions for a type this never decodes at all', () => {
    expect(imageDimensionsOf(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]))).toBeUndefined();
    expect(imageDimensionsOf(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeUndefined();
  });

  it('reads no dimensions from bytes outside the closed signature set', () => {
    expect(imageDimensionsOf(new TextEncoder().encode('not media'))).toBeUndefined();
  });
});
