import { describe, expect, it } from 'vitest';

import { parseRunAdditionBody, parseRunStartBody, parseRunThemeBody } from './runs.js';

describe('parseRunStartBody', () => {
  it('accepts a rehearsal or a live start with no override', () => {
    expect(parseRunStartBody({ serviceId: 's1', mode: 'rehearsal' })).toEqual({ ok: true, value: { serviceId: 's1', mode: 'rehearsal' } });
    expect(parseRunStartBody({ serviceId: 's1', mode: 'live' })).toEqual({ ok: true, value: { serviceId: 's1', mode: 'live' } });
  });

  it('accepts a live start with an override reason', () => {
    const body = { serviceId: 's1', mode: 'live', override: { reason: 'Choir already assembled' } };
    expect(parseRunStartBody(body)).toEqual({ ok: true, value: body });
  });

  it('refuses an override on a rehearsal start', () => {
    const parsed = parseRunStartBody({ serviceId: 's1', mode: 'rehearsal', override: { reason: 'x' } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toMatchObject({ path: 'run.override', code: 'field.not_allowed' });
  });

  it('refuses an override with an empty reason', () => {
    expect(parseRunStartBody({ serviceId: 's1', mode: 'live', override: { reason: '' } }).ok).toBe(false);
  });
});

describe('parseRunThemeBody', () => {
  it('accepts a known surface and a theme id', () => {
    expect(parseRunThemeBody({ surface: 'audience', theme: 'dark' })).toEqual({ ok: true, value: { surface: 'audience', theme: 'dark' } });
  });

  it('refuses an unknown surface', () => {
    expect(parseRunThemeBody({ surface: 'projector', theme: 'dark' }).ok).toBe(false);
  });
});

describe('parseRunAdditionBody', () => {
  it('accepts a mid-service addition with no saveToLibrary', () => {
    const parsed = parseRunAdditionBody({ kind: 'reusableSlide', title: 'Announcement', body: 'Potluck moved to 1pm' });
    expect(parsed.ok).toBe(true);
  });
});
