import { describe, expect, it } from 'vitest';
import { HolyDeckError, formatMessage, messageCatalog } from './messages.js';

describe('formatMessage', () => {
  it('interpolates named params', () => {
    expect(formatMessage('unknown_translation', { abbr: 'XYZ', known: 'KJV, SCH2000' })).toBe(
      'Unknown translation "XYZ". Known: KJV, SCH2000.',
    );
  });

  it('leaves unknown placeholders literal instead of throwing', () => {
    expect(formatMessage('unknown_translation', { abbr: 'XYZ' })).toBe(
      'Unknown translation "XYZ". Known: {known}.',
    );
  });

  it('has no message text ending without punctuation', () => {
    for (const text of Object.values(messageCatalog)) {
      expect(text).toMatch(/[.!?}]$/);
    }
  });

  it('formats the CLI cache footer', () => {
    expect(formatMessage('cache_footer', { rev: 3, date: '2026-09-01', abbr: 'KJV', book: 'PSA', chapter: 117 })).toBe(
      'source: cache · revision 3 · fetched 2026-09-01 — KJV PSA 117',
    );
  });

  it('formats the local-only refusal', () => {
    expect(formatMessage('local_only_command', { command: 'sync' })).toBe(
      '"holydeck sync" works on the local datastore and is not available in server mode (--server-url). Run it where the data lives.',
    );
  });

  it('formats server errors', () => {
    expect(formatMessage('server_error', { status: 502, url: 'https://holydeck.example.com/api/v1/translations', message: 'upstream down' })).toBe(
      'Server error (HTTP 502) from https://holydeck.example.com/api/v1/translations: upstream down',
    );
  });
});

describe('HolyDeckError', () => {
  it('carries code, params and a formatted message', () => {
    const error = new HolyDeckError('scrape_http_error', { status: 503, url: 'https://example.test/x' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HolyDeckError');
    expect(error.code).toBe('scrape_http_error');
    expect(error.params).toEqual({ status: 503, url: 'https://example.test/x' });
    expect(error.message).toBe('bible.com request failed: HTTP 503 for https://example.test/x');
  });

  it('defaults params to an empty object', () => {
    const error = new HolyDeckError('scrape_blocked');
    expect(error.params).toEqual({});
    expect(error.message).toContain('bot-protection challenge');
  });
});

describe('server message codes', () => {
  it('formats the sync-job messages, interpolating the abbreviation twice', () => {
    expect(formatMessage('sync_already_running', { abbr: 'KJV' })).toBe(
      'A sync job for KJV is already running. Poll GET /api/v1/translations/KJV/sync.',
    );
    expect(formatMessage('sync_job_not_found', { abbr: 'KJV' })).toBe(
      'No sync job for KJV. Start one with POST /api/v1/translations/KJV/sync.',
    );
    expect(formatMessage('sync_interrupted', { abbr: 'NIV' })).toBe(
      'The sync job for NIV was interrupted by a server restart. Start it again.',
    );
  });

  it('formats the request, route and deprecation messages', () => {
    expect(formatMessage('request_invalid', { reason: "querystring must have required property 'book'" })).toBe(
      "Invalid request: querystring must have required property 'book'.",
    );
    expect(formatMessage('route_not_found', { method: 'GET', path: '/nope' })).toBe(
      'Unknown endpoint: GET /nope. This response lists the available endpoints.',
    );
    expect(
      formatMessage('deprecated_route', {
        oldRoute: 'GET /api/v1/verse',
        newRoute: 'GET /api/v1/translations/:abbr/verses',
      }),
    ).toBe('GET /api/v1/verse is deprecated; use GET /api/v1/translations/:abbr/verses instead.');
    expect(messageCatalog.internal_error).toBe('Unexpected server error.');
    expect(messageCatalog.rate_limit_exceeded).toBe('Rate limit exceeded. Try again later.');
  });
});
