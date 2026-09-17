import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { SLIDE_GROUP_MODES, parseSlide, parseSlideGroupBody, resolveSlide } from './slide-groups.js';

import type { Slide, SlideGroupBody } from './slide-groups.js';

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

  it('round-trips an optional slideLayoutId and background override', () => {
    const overridden = { ...SLIDE, slideLayoutId: 'layout-b', background: 'crimson' };
    expect(parseSlide(overridden, 'slide')).toEqual({ ok: true, value: overridden });
  });

  it('refuses a present-but-empty slideLayoutId or background override, like the group’s own required field', () => {
    const emptyLayout = parseSlide({ ...SLIDE, slideLayoutId: '' }, 'slide');
    expect(emptyLayout.ok).toBe(false);
    expect(!emptyLayout.ok && emptyLayout.problems).toContainEqual({
      path: 'slide.slideLayoutId',
      code: FIELD_CODES.empty,
      message: 'must not be empty',
    });

    const emptyBackground = parseSlide({ ...SLIDE, background: '' }, 'slide');
    expect(emptyBackground.ok).toBe(false);
    expect(!emptyBackground.ok && emptyBackground.problems).toContainEqual({
      path: 'slide.background',
      code: FIELD_CODES.empty,
      message: 'must not be empty',
    });
  });
});

describe('reading a SlideGroupBody', () => {
  it('names the two modes a group of slides can be authored under', () => {
    expect([...SLIDE_GROUP_MODES]).toEqual(['custom', 'generated']);
  });

  it('round-trips a custom group with no generatedFrom', () => {
    const body = { mode: 'custom', enabled: true, slideLayoutId: 'layout-a', slides: [SLIDE] };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });

  it('round-trips a generated group carrying an opaque generatedFrom, unread', () => {
    const body = {
      mode: 'generated',
      enabled: false,
      slideLayoutId: 'layout-a',
      slides: [],
      generatedFrom: { songId: 'song-1', revision: 3 },
    };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });

  it('accepts an empty slide list', () => {
    const body = { mode: 'custom', enabled: true, slideLayoutId: 'layout-a', slides: [] };
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
    const parsed = parseSlideGroupBody(
      { mode: 'generated', enabled: true, slideLayoutId: 'layout-a', slides: [], generatedFrom: 'nope' },
      'group',
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'group.generatedFrom', code: FIELD_CODES.notAnObject, message: 'must be an object' },
    ]);
  });

  it('refuses a malformed slide inside the list, naming its own path', () => {
    const parsed = parseSlideGroupBody(
      { mode: 'custom', enabled: true, slideLayoutId: 'layout-a', slides: [{ id: 'x' }] },
      'group',
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'group.slides.0.enabled',
      'group.slides.0.label',
    ]);
  });

  it('refuses a missing mode, enabled, slideLayoutId, or slides', () => {
    const parsed = parseSlideGroupBody({}, 'group');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'group.mode',
      'group.enabled',
      'group.slideLayoutId',
      'group.slides',
    ]);
  });

  it('round-trips a group background', () => {
    const body = {
      mode: 'custom',
      enabled: true,
      slideLayoutId: 'layout-a',
      background: 'navy',
      slides: [SLIDE],
    };
    expect(parseSlideGroupBody(body, 'group')).toEqual({ ok: true, value: body });
  });
});

describe("resolving a slide's effective background and Slide Layout (SLID-02)", () => {
  const GROUP: SlideGroupBody = {
    mode: 'custom',
    enabled: true,
    slideLayoutId: 'layout-a',
    background: 'navy',
    slides: [SLIDE],
  };

  it('inherits both fields when the slide carries no override', () => {
    expect(resolveSlide(GROUP, SLIDE)).toEqual({
      slideLayoutId: { value: 'layout-a', source: 'inherited' },
      background: { value: 'navy', source: 'inherited' },
    });
  });

  it('resolves from the group as given, not a value copied earlier — the same slide resolves differently against a different group value', () => {
    const movedOn: SlideGroupBody = { ...GROUP, slideLayoutId: 'layout-b', background: 'crimson' };
    expect(resolveSlide(movedOn, SLIDE)).toEqual({
      slideLayoutId: { value: 'layout-b', source: 'inherited' },
      background: { value: 'crimson', source: 'inherited' },
    });
  });

  it('lets an explicit override win, visibly marked, independent of the other field', () => {
    const overridden: Slide = { ...SLIDE, slideLayoutId: 'layout-c' };
    expect(resolveSlide(GROUP, overridden)).toEqual({
      slideLayoutId: { value: 'layout-c', source: 'override' },
      background: { value: 'navy', source: 'inherited' },
    });
  });

  it('inherits an absent group background as undefined, still marked inherited', () => {
    const noBackground: SlideGroupBody = {
      mode: 'custom',
      enabled: true,
      slideLayoutId: 'layout-a',
      slides: [SLIDE],
    };
    expect(resolveSlide(noBackground, SLIDE)).toEqual({
      slideLayoutId: { value: 'layout-a', source: 'inherited' },
      background: { value: undefined, source: 'inherited' },
    });
  });
});
