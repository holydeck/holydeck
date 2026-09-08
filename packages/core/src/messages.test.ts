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
