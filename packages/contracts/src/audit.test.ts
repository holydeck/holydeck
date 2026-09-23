import { describe, expect, it } from 'vitest';

import { parseAuditQuery } from './audit.js';

describe('parseAuditQuery', () => {
  it('defaults limit to 50 with no other fields', () => {
    const result = parseAuditQuery({});
    expect(result).toEqual({ ok: true, value: { limit: 50 } });
  });

  it('accepts category, action, actor, outcome, from, to', () => {
    const result = parseAuditQuery({
      category: 'authentication',
      action: 'session.signIn',
      actor: 'account:1',
      outcome: 'allowed',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-22T00:00:00.000Z',
      limit: '10',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        category: 'authentication',
        action: 'session.signIn',
        actor: 'account:1',
        outcome: 'allowed',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-22T00:00:00.000Z',
        limit: 10,
      },
    });
  });

  it('normalizes the instants it accepts, so the store compares like with like', () => {
    const result = parseAuditQuery({ from: '2026-09-01T02:00:00+02:00', to: '2026-09-22T10:00:00Z' });
    expect(result).toEqual({ ok: true, value: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-22T10:00:00.000Z', limit: 50 } });
  });

  it('reads a bare date as the whole of that day', () => {
    const result = parseAuditQuery({ from: '2026-09-01', to: '2026-09-22' });
    expect(result).toEqual({ ok: true, value: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-22T23:59:59.999Z', limit: 50 } });
  });

  it('rejects text that is not an ISO date or instant, even where Date.parse would guess', () => {
    expect(parseAuditQuery({ from: 'September 1, 2026' }).ok).toBe(false);
    expect(parseAuditQuery({ to: '2026-09-31' }).ok).toBe(false);
  });

  it('rejects an invalid outcome', () => {
    expect(parseAuditQuery({ outcome: 'maybe' }).ok).toBe(false);
  });

  it('rejects a limit over 100', () => {
    expect(parseAuditQuery({ limit: '101' }).ok).toBe(false);
  });

  it('rejects an unparseable from', () => {
    expect(parseAuditQuery({ from: 'not-a-date' }).ok).toBe(false);
  });

  it('rejects cursorAt without cursorId', () => {
    expect(parseAuditQuery({ cursorAt: '2026-09-22T00:00:00.000Z' }).ok).toBe(false);
  });

  it('accepts a matched cursor pair', () => {
    const result = parseAuditQuery({ cursorAt: '2026-09-22T00:00:00.000Z', cursorId: 'audit:abc' });
    expect(result.ok).toBe(true);
  });
});
