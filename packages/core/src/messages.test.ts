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
