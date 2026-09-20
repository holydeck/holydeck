import { describe, expect, it } from 'vitest';

import {
  languageForItem,
  nextStagePosition,
  resolveStagePosition,
  selectStageLanguage,
  stageCue,
  stageLookAhead,
  surfaceCue,
} from './stage-state.js';

import type { StageItem, SurfaceLanguages } from './stage-state.js';

// Two songs and one item with nothing in it. The first declares both of the registry's languages and a
// key; the second declares only the romanization and no key at all, which is what makes the key and the
// language-fallback rules observable rather than asserted against a fixture built to agree with them.
const ASCENT: StageItem = {
  id: 'item-ascent',
  title: 'Aaraadhanai',
  languages: ['ta', 'ta-Latn'],
  key: 'G',
  slides: [
    { ta: 'ஆராதனை', 'ta-Latn': 'Aaraadhanai' },
    { ta: 'துதி', 'ta-Latn': 'Thuthi' },
  ],
};

const PSALM: StageItem = {
  id: 'item-psalm',
  title: 'Enakku Idaiyan',
  languages: ['ta-Latn'],
  slides: [{ 'ta-Latn': 'Enakku Idaiyan' }, { 'ta-Latn': 'Kurai Onrum Illai' }, { 'ta-Latn': 'Pachai Pull' }],
};

const ANNOUNCEMENT: StageItem = {
  id: 'item-announcement',
  title: 'Announcements',
  languages: ['ta-Latn'],
  slides: [],
};

const ORDER: readonly StageItem[] = [ASCENT, PSALM];

// ---------------------------------------------------------------------------------------------------
// Looking ahead across item boundaries
// ---------------------------------------------------------------------------------------------------

describe('Stage look-ahead', () => {
  it('has the next slide of the same item while that item still has one', () => {
    const look = stageLookAhead(ORDER, { item: 0, slide: 0 }, 'ta');

    expect(look.current?.position).toEqual({ item: 0, slide: 0 });
    expect(look.current?.text).toBe('ஆராதனை');
    expect(look.next?.position).toEqual({ item: 0, slide: 1 });
    expect(look.next?.text).toBe('துதி');
  });

  it('crosses into the next item once the current item runs out of slides', () => {
    const look = stageLookAhead(ORDER, { item: 0, slide: 1 }, 'ta');

    expect(look.current?.position).toEqual({ item: 0, slide: 1 });
    expect(look.next?.position).toEqual({ item: 1, slide: 0 });
    expect(look.next?.title).toBe('Enakku Idaiyan');
    expect(look.next?.text).toBe('Enakku Idaiyan');
  });

  it('reads the next item in the next item’s own language when it never declared the preferred one', () => {
    const look = stageLookAhead(ORDER, { item: 0, slide: 1 }, 'ta');

    expect(look.current?.languageKey).toBe('ta');
    expect(look.next?.languageKey).toBe('ta-Latn');
  });

  it('steps over an item carrying no slides rather than stopping at it', () => {
    const order = [ASCENT, ANNOUNCEMENT, PSALM];

    expect(nextStagePosition(order, { item: 0, slide: 1 })).toEqual({ item: 2, slide: 0 });
  });

  it('has no next at the last slide of the last item — no wraparound to the first', () => {
    const look = stageLookAhead(ORDER, { item: 1, slide: 2 }, 'ta-Latn');

    expect(look.current?.position).toEqual({ item: 1, slide: 2 });
    expect(look.next).toBeUndefined();
  });

  it('has neither position in a service with no items', () => {
    expect(stageLookAhead([], { item: 0, slide: 0 }, 'ta')).toEqual({ current: undefined, next: undefined });
    expect(nextStagePosition([], { item: 0, slide: 0 })).toBeUndefined();
  });

  it('is at nothing on an item with no slides, and still looks ahead past it', () => {
    const order = [ANNOUNCEMENT, PSALM];

    expect(resolveStagePosition(order, { item: 0, slide: 0 })).toBeUndefined();
    expect(stageCue(order, { item: 0, slide: 0 }, 'ta-Latn')).toBeUndefined();
    expect(nextStagePosition(order, { item: 0, slide: 0 })).toEqual({ item: 1, slide: 0 });
  });

  it('has no next when the only item left after this one carries no slides', () => {
    expect(nextStagePosition([ASCENT, ANNOUNCEMENT], { item: 0, slide: 1 })).toBeUndefined();
  });

  it('clamps a position before the start and past the end onto the nearest real slide', () => {
    expect(resolveStagePosition(ORDER, { item: -4, slide: -9 })).toEqual({ item: 0, slide: 0 });
    expect(resolveStagePosition(ORDER, { item: 99, slide: 99 })).toEqual({ item: 1, slide: 2 });
    expect(nextStagePosition(ORDER, { item: 99, slide: 99 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// The song key
// ---------------------------------------------------------------------------------------------------

describe('the song key on a Stage cue', () => {
  it('is shown when the item carries one', () => {
    expect(stageCue(ORDER, { item: 0, slide: 0 }, 'ta')).toEqual({
      position: { item: 0, slide: 0 },
      title: 'Aaraadhanai',
      languageKey: 'ta',
      text: 'ஆராதனை',
      key: 'G',
    });
  });

  it('is omitted cleanly — the field is absent, not an empty or placeholder value — when there is none', () => {
    const cue = stageCue(ORDER, { item: 1, slide: 0 }, 'ta-Latn');

    expect(cue).toEqual({
      position: { item: 1, slide: 0 },
      title: 'Enakku Idaiyan',
      languageKey: 'ta-Latn',
      text: 'Enakku Idaiyan',
    });
    expect(cue === undefined ? true : 'key' in cue).toBe(false);
  });

  it('is omitted the same way for a key that is only whitespace', () => {
    const blank: StageItem = { ...ASCENT, key: '   ' };
    const cue = stageCue([blank], { item: 0, slide: 0 }, 'ta');

    expect(cue === undefined ? true : 'key' in cue).toBe(false);
    expect(cue?.title).toBe('Aaraadhanai');
  });

  it('is shown trimmed, and looks ahead onto a next cue that carries its own key or none', () => {
    const padded: StageItem = { ...ASCENT, key: ' A♭ ' };
    const look = stageLookAhead([padded, PSALM], { item: 0, slide: 1 }, 'ta');

    expect(look.current?.key).toBe('A♭');
    expect(look.next?.key).toBeUndefined();
  });

  it('is never carried by the cue the other surfaces render', () => {
    const cue = surfaceCue(ORDER, { item: 0, slide: 0 }, 'ta');

    expect(cue === undefined ? true : 'key' in cue).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// A Stage-local language selection
// ---------------------------------------------------------------------------------------------------

const AT = { item: 0, slide: 0 } as const;
const EVERY_SURFACE_IN_TAMIL: SurfaceLanguages = { audience: 'ta', stage: 'ta', singer: 'ta' };

describe('a Stage-local language selection', () => {
  it('moves Stage alone: Audience and Singer keep both their language and the cue they render', () => {
    const before = EVERY_SURFACE_IN_TAMIL;
    const audienceShowed = structuredClone(surfaceCue(ORDER, AT, before.audience));
    const singerShowed = structuredClone(surfaceCue(ORDER, AT, before.singer));

    const after = selectStageLanguage(before, ASCENT, 'ta-Latn');

    // Stage really moved: not just the record's field, but the words on the Stage screen.
    expect(after.stage).toBe('ta-Latn');
    expect(stageLookAhead(ORDER, AT, after.stage).current?.text).toBe('Aaraadhanai');
    expect(stageLookAhead(ORDER, AT, before.stage).current?.text).toBe('ஆராதனை');

    // And the other two did not, in either the record or what they render.
    expect(after.audience).toBe('ta');
    expect(after.singer).toBe('ta');
    expect(surfaceCue(ORDER, AT, after.audience)).toEqual(audienceShowed);
    expect(surfaceCue(ORDER, AT, after.singer)).toEqual(singerShowed);
    expect(audienceShowed?.text).toBe('ஆராதனை');
    expect(before).toEqual({ audience: 'ta', stage: 'ta', singer: 'ta' });
  });

  it('refuses a language this item never declared, leaving all three surfaces where they were', () => {
    const after = selectStageLanguage(EVERY_SURFACE_IN_TAMIL, PSALM, 'ta');

    expect(after).toEqual({ audience: 'ta', stage: 'ta', singer: 'ta' });
    expect(stageLookAhead([PSALM], AT, after.stage).current?.languageKey).toBe('ta-Latn');
  });

  it('refuses a key the content-language registry does not carry', () => {
    const invented: StageItem = { ...ASCENT, languages: ['ta', 'kl-Zzzz'] };

    expect(selectStageLanguage(EVERY_SURFACE_IN_TAMIL, invented, 'kl-Zzzz')).toEqual({
      audience: 'ta',
      stage: 'ta',
      singer: 'ta',
    });
  });

  it('refuses a selection made against no item at all', () => {
    expect(selectStageLanguage(EVERY_SURFACE_IN_TAMIL, undefined, 'ta-Latn')).toEqual({
      audience: 'ta',
      stage: 'ta',
      singer: 'ta',
    });
  });
});

describe('languageForItem', () => {
  it('honours a preference the item declares', () => {
    expect(languageForItem(ASCENT, 'ta-Latn')).toBe('ta-Latn');
  });

  it('falls back to the item’s own first language for a preference it does not declare', () => {
    expect(languageForItem(PSALM, 'ta')).toBe('ta-Latn');
  });

  it('falls back to the item’s own first language when no preference was expressed', () => {
    expect(languageForItem(ASCENT, undefined)).toBe('ta');
  });

  it('is nothing at all for an item that declares no languages', () => {
    const wordless: StageItem = { ...ASCENT, languages: [] };

    expect(languageForItem(wordless, 'ta')).toBeUndefined();
    expect(stageCue([wordless], AT, 'ta')).toEqual({
      position: { item: 0, slide: 0 },
      title: 'Aaraadhanai',
      languageKey: undefined,
      text: '',
      key: 'G',
    });
  });

  it('renders empty text for a slide that has nothing in the language being read', () => {
    const untranslated: StageItem = { ...ASCENT, slides: [{ 'ta-Latn': 'Aaraadhanai' }, {}] };

    expect(stageCue([untranslated], { item: 0, slide: 1 }, 'ta')?.text).toBe('');
  });
});
