import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { SLIDE_GROUP_MODES, parseSlide, parseSlideGroupBody } from './slide-groups.js';

const SLIDE = { id: 'slide-1', enabled: true, label: 'Welcome' };

describe('reading a Slide', () => {
  it('round-trips id, enabled, and label', () => {
    const parsed = parseSlide(SLIDE, 'slide');
    expect(parsed).toEqual({ ok: true, value: SLIDE });
  });

  it('refuses a missing field with its own problem, one per field', () => {
    const parsed = parseSlide({}, 'slide');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'slide.id',
      'slide.enabled',
      'slide.label',
    ]);
  });
});

describe('reading a SlideGroupBody', () => {
  it('names the two modes a group of slides can be authored under', () => {
    expect([...SLIDE_GROUP_MODES]).toEqual(['custom', 'generated']);
  });

  it('round-trips a custom group with no generatedFrom', () => {
    const body = { mode: 'custom', enabled: true, slides: [SLIDE] };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });

  it('round-trips a generated group carrying an opaque generatedFrom, unread', () => {
    const body = { mode: 'generated', enabled: false, slides: [], generatedFrom: { songId: 'song-1', revision: 3 } };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });

  it('accepts an empty slide list', () => {
    const body = { mode: 'custom', enabled: true, slides: [] };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });

  it('refuses a mode outside SLIDE_GROUP_MODES', () => {
    const parsed = parseSlideGroupBody({ mode: 'bespoke', enabled: true, slides: [] }, 'group');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toContainEqual({
      path: 'group.mode',
      code: FIELD_CODES.notAllowed,
      message: `must be one of ${SLIDE_GROUP_MODES.join(', ')}`,
    });
  });

  it('refuses a generatedFrom that is not an object', () => {
    const parsed = parseSlideGroupBody({ mode: 'generated', enabled: true, slides: [], generatedFrom: 'nope' }, 'group');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'group.generatedFrom', code: FIELD_CODES.notAnObject, message: 'must be an object' },
    ]);
  });

  it('refuses a malformed slide inside the list, naming its own path', () => {
    const parsed = parseSlideGroupBody({ mode: 'custom', enabled: true, slides: [{ id: 'x' }] }, 'group');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'group.slides.0.enabled',
      'group.slides.0.label',
    ]);
  });

  it('refuses a missing mode, enabled, or slides', () => {
    const parsed = parseSlideGroupBody({}, 'group');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'group.mode',
      'group.enabled',
      'group.slides',
    ]);
  });
});
