import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { API_ENDPOINTS, errorEnvelope, statusForCode } from './errors.js';

describe('statusForCode', () => {
  it('maps caller mistakes to 400', () => {
    expect(statusForCode('invalid_verse_list')).toBe(400);
    expect(statusForCode('sermon_invalid')).toBe(400);
    expect(statusForCode('template_invalid')).toBe(400);
    expect(statusForCode('request_invalid')).toBe(400);
  });

  it('maps missing resources to 404', () => {
    expect(statusForCode('unknown_translation')).toBe(404);
    expect(statusForCode('chapter_not_in_store')).toBe(404);
    expect(statusForCode('verse_not_in_store')).toBe(404);
    expect(statusForCode('revision_not_found')).toBe(404);
    expect(statusForCode('sync_job_not_found')).toBe(404);
    expect(statusForCode('route_not_found')).toBe(404);
  });

  it('maps contention to 409 and upstream failures to 502', () => {
    expect(statusForCode('store_locked')).toBe(409);
    expect(statusForCode('sync_already_running')).toBe(409);
    expect(statusForCode('scrape_blocked')).toBe(502);
    expect(statusForCode('scrape_http_error')).toBe(502);
    expect(statusForCode('scrape_network_error')).toBe(502);
    expect(statusForCode('scrape_parse_failed')).toBe(502);
    expect(statusForCode('version_meta_invalid')).toBe(502);
  });

  it('defaults unmapped codes to 500', () => {
    expect(statusForCode('internal_error')).toBe(500);
    expect(statusForCode('store_corrupt')).toBe(500);
    expect(statusForCode('sync_interrupted')).toBe(500);
  });
});

describe('errorEnvelope', () => {
  it('wraps a HolyDeckError into the single envelope shape', () => {
    const error = new HolyDeckError('unknown_translation', { abbr: 'ZZZ' });
    expect(errorEnvelope(error)).toEqual({
      error: { code: 'unknown_translation', message: error.message },
    });
  });
});

describe('API_ENDPOINTS', () => {
  it('lists exactly the eight public endpoints', () => {
    expect(Object.keys(API_ENDPOINTS).sort()).toEqual(
      [
        'GET /health',
        'GET /api/v1/translations',
        'GET /api/v1/translations/:abbr/canon',
        'GET /api/v1/translations/:abbr/verses',
        'POST /api/v1/translations/:abbr/sync',
        'GET /api/v1/translations/:abbr/sync',
        'GET /api/v1/stats',
        'POST /api/v1/render',
      ].sort(),
    );
  });

  it('uses METHOD /path keys with non-empty descriptions', () => {
    for (const [key, description] of Object.entries(API_ENDPOINTS)) {
      expect(key).toMatch(/^(GET|POST) \//);
      expect(description.length).toBeGreaterThan(0);
    }
  });
});
