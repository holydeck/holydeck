import { describe, expect, it } from 'vitest';

import { MEDIA_PROCESSING_STATES, parseMediaManifestEntry, sniffMediaType } from './media.js';
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
