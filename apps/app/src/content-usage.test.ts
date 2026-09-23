import { parseSermonFile } from '@holydeck/core/sermon';
import { describe, expect, test } from 'vitest';

import { contentUsage, labelKey } from './content-usage.js';
import { libraryOn } from './library.js';
import { sermonContext, sermonsOn } from './sermons.js';
import { slideGroupContext, slideGroupsOn } from './slide-groups.js';
import { songContext, songsOn } from './songs.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SermonBody } from './sermons.js';
import type { SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { SongBody } from '@holydeck/contracts/songs';

const ACTOR = `account:${'C'.repeat(22)}`;
const CORRELATION = 'req-usage';
const now = (): string => '2026-09-22T09:30:00.000Z';

// Every field a substring scan would have mistaken for "ml": a title, a label and the provenance.
const SONG: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Psalm ml' },
  languages: ['ta', 'ta-Latn'],
  sections: [
    { id: 'v1', label: 'Verse', text: [{ languageKey: 'ta', text: 'வரிகள்' }] },
    { id: 'v2', label: '  verse ', text: [{ languageKey: 'ta-Latn', text: 'html' }] },
    { id: 'c1', label: 'Chorus', text: [] },
  ],
  provenance: { source: 'manual' },
};

const GROUP: SlideGroupBody = {
  mode: 'custom',
  enabled: true,
  slideLayoutId: 'layout-1',
  slides: [
    { id: 's1', enabled: true, label: 'Chorus', languageBlocks: [{ id: 'b1', languageKey: 'ta', text: 'x' }] },
    { id: 's2', enabled: true, label: 'Bridge', languageBlocks: [{ id: 'b2', languageKey: 'ta', text: 'y' }] },
  ],
};

const SERMON: SermonBody = {
  sermon: parseSermonFile(`translations: [TAM]
verses:
  - {book: PSA, chapter: 117, verses: 1}
`),
  languages: { ta: { translation: 'TAM', title: 'நன்றி', speaker: 'பேச்சாளர்', points: ['துதி'] } },
};

const stores = () => {
  const db = fakeDb();
  return {
    library: libraryOn(db, { now }),
    songs: songsOn(db, { now }),
    slideGroups: slideGroupsOn(db, { now }),
    sermons: sermonsOn(db, { now }),
  };
};

describe('content usage', () => {
  test('counts nothing in an empty library', async () => {
    const usage = await contentUsage(stores(), ACTOR, CORRELATION);
    expect(usage.languages.size).toBe(0);
    expect(usage.labels.size).toBe(0);
  });

  test('counts each item once per language it declares, and never a key that only appears in its text', async () => {
    const held = stores();
    await held.songs.create(songContext(ACTOR, CORRELATION), 'Psalm', SONG);
    await held.slideGroups.create(slideGroupContext(ACTOR, CORRELATION), 'slideGroup', 'Group', GROUP);
    const usage = await contentUsage(held, ACTOR, CORRELATION);
    expect(usage.languages.get('ta')).toBe(2);
    expect(usage.languages.get('ta-Latn')).toBe(1);
    expect(usage.languages.has('ml')).toBe(false);
  });

  test('counts labels by name, whatever their case or spacing, once per item', async () => {
    const held = stores();
    await held.songs.create(songContext(ACTOR, CORRELATION), 'Psalm', SONG);
    await held.slideGroups.create(slideGroupContext(ACTOR, CORRELATION), 'reusableSlide', 'Group', GROUP);
    const usage = await contentUsage(held, ACTOR, CORRELATION);
    expect(usage.labels.get(labelKey('Verse'))).toBe(1);
    expect(usage.labels.get(labelKey('CHORUS'))).toBe(2);
    expect(usage.labels.get(labelKey('Bridge'))).toBe(1);
  });

  test('counts a sermon by the languages it carries, and none without a sermon store', async () => {
    const held = stores();
    await held.sermons.create(sermonContext(ACTOR, CORRELATION), 'Sunday', SERMON);
    expect((await contentUsage(held, ACTOR, CORRELATION)).languages.get('ta')).toBe(1);
    expect((await contentUsage({ ...held, sermons: undefined }, ACTOR, CORRELATION)).languages.has('ta')).toBe(false);
  });

  test('spells a label key trimmed, single-spaced and lower-case', () => {
    expect(labelKey('  Verse   One ')).toBe('verse one');
  });
});
