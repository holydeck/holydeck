import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';

import { libraryContext, libraryOn } from './library.js';
import { PaletteError, paletteOn } from './palette.js';
import { LAYOUTS_MANAGE, PRESENTATION_CONTROL } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { songContext, songsOn } from './songs.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { CorpusSearchHit, CorpusTranslation } from '@holydeck/contracts/corpus';

import type { SlideLayoutBody } from '@holydeck/contracts/layouts';

import type { ServiceDraft } from '@holydeck/contracts/services';

import type { SongBody } from '@holydeck/contracts/songs';

import type { corpusClient, CorpusResult } from './corpus.js';
import type { PaletteSession, PaletteStore } from './palette.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ACTOR = `account:${'P'.repeat(22)}`;

const CORRELATION = 'req-palette-01';

const TRANSLATION = 'KJV';

const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;

const TA = TAMIL!.key;

const TA_LATN = ROMANIZED_TAMIL!.key;

const ADMIN_SESSION: PaletteSession = {
  actor: ACTOR,
  permissions: [PRESENTATION_CONTROL, LAYOUTS_MANAGE],
  correlationId: CORRELATION,
};

const MEMBER_SESSION: PaletteSession = { actor: ACTOR, permissions: [PRESENTATION_CONTROL], correlationId: CORRELATION };

const BARE_SESSION: PaletteSession = { actor: ACTOR, permissions: [], correlationId: CORRELATION };

/** A song this store already validates elsewhere (songs.test.ts): unrelated content that never
 *  accidentally matches any query this file searches for, so a fixture only needs to override titles. */
const SONG: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: [TA, TA_LATN],
  sections: [
    { id: 'verse-1', label: 'Verse 1', text: [{ languageKey: TA, text: 'முதல் வரி' }, { languageKey: TA_LATN, text: 'Muthal vari' }] },
  ],
  provenance: { source: 'manual' },
};

const LAYOUT_BOX = {
  id: 'lyric',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' },
  style: { fontFamily: 'Inter', fontWeight: 600, sizeRatio: 0.08, lineHeight: 1.25, align: 'center', verticalAlign: 'center' },
} as const;

const LAYOUT_BODY: SlideLayoutBody = { boxes: [LAYOUT_BOX] };

const serviceDraft = (title: string): ServiceDraft => ({ title, date: '2026-09-13', site: 'Main Hall', sections: [] });

/** A fake `corpusClient` built as a plain object, not through `Fetching`: `PaletteOptions.corpus` is
 *  typed structurally, so there is nothing an HTTP mock would prove here that this does not. */
function fakeCorpus(config: {
  readonly canonBook?: { readonly usfm: string; readonly chapter: string };
  readonly verseText?: Readonly<Record<string, string>>;
  readonly searchHits?: readonly CorpusSearchHit[];
  readonly failSearch?: boolean;
}): ReturnType<typeof corpusClient> {
  const translation: CorpusTranslation = {
    abbreviation: TRANSLATION,
    id: 1,
    title: 'King James Version',
    language: 'en',
    syncedChapters: 1,
    canonChapters: 1,
    cached: true,
  };
  return {
    translations: async () => ({ ok: true, value: [translation] }),
    canon: async (abbr) => ({
      ok: true,
      value: {
        translation: abbr,
        source: 'bundled',
        books:
          config.canonBook === undefined
            ? []
            : [
                {
                  usfm: config.canonBook.usfm,
                  canon: 'nt',
                  name: config.canonBook.usfm,
                  chapters: [{ id: config.canonBook.chapter, label: config.canonBook.chapter }],
                },
              ],
      },
    }),
    verses: async (_abbr, book, chapter, verses) => {
      const record: Record<string, string> = {};
      for (const verse of verses) record[String(verse)] = config.verseText?.[`${book}:${chapter}:${verse}`] ?? '';
      return {
        ok: true,
        value: { verses: record, citation: `${book} ${chapter}`, revision: 1, fetchedAt: '2026-09-13T00:00:00.000Z', source: 'cache' },
      };
    },
    search: async (abbr, query): Promise<CorpusResult<{ translation: string; query: string; hits: readonly CorpusSearchHit[] }>> => {
      if (config.failSearch === true) return { ok: false, refusal: { code: 'corpus.unavailable', status: 503, message: 'down' } };
      return { ok: true, value: { translation: abbr, query, hits: config.searchHits ?? [] } };
    },
  };
}

interface Scenario {
  readonly db: FakeDb;
  readonly palette: PaletteStore;
  readonly library: ReturnType<typeof libraryOn>;
  readonly songs: ReturnType<typeof songsOn>;
  readonly slideLayouts: ReturnType<typeof slideLayoutsOn>;
  readonly services: ReturnType<typeof servicesOn>;
}

/** One palette wired to fresh, empty stores, plus the same stores directly so a test can seed exactly
 *  the content it needs before calling `palette.search`. */
function scenario(corpus: ReturnType<typeof corpusClient> = fakeCorpus({})): Scenario {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const options = {
    now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
    newId: () => `id-${(serial += 1)}`,
  };
  return {
    db,
    palette: paletteOn(db, { corpus, referenceTranslation: TRANSLATION, ...options }),
    library: libraryOn(db, options),
    songs: songsOn(db, options),
    slideLayouts: slideLayoutsOn(db, options),
    services: servicesOn(db, options),
  };
}

const refused = async (call: Promise<unknown>): Promise<PaletteError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof PaletteError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
};

describe('paletteOn: source coverage', () => {
  it('reference: resolves a canon-validated Scripture reference directly, without a text search', async () => {
    const corpus = fakeCorpus({ canonBook: { usfm: 'JHN', chapter: '3' }, verseText: { 'JHN:3:16': 'For God so loved the world' } });
    const { palette } = scenario(corpus);
    const hits = await palette.search(ADMIN_SESSION, 'John 3:16');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'reference', title: 'JHN 3:16', explanation: 'matched as a Scripture reference' });
  });

  it('scripture: word/phrase search over Bible text this deployment already caches', async () => {
    const hit: CorpusSearchHit = {
      book: 'Romans', bookOrder: 6, chapter: 3, verse: 24, text: 'justified freely by his grace', revision: 1, phrase: true, occurrences: 1,
    };
    const { palette } = scenario(fakeCorpus({ searchHits: [hit] }));
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'scripture');
    expect(found).toMatchObject({ explanation: 'matched the phrase in the verse text', occurrences: 1 });
  });

  it('song: matches a song on its titles', async () => {
    const { palette, songs } = scenario();
    await songs.create(songContext(ACTOR, CORRELATION), 'Amazing Grace', { ...SONG, titles: { tamil: '', romanized: 'Amazing Grace' } });
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'song');
    expect(found).toMatchObject({ title: 'Amazing Grace', explanation: 'matched the phrase in the romanized title' });
  });

  it('slide: matches a reusable slide on its library title', async () => {
    const { palette, library } = scenario();
    await library.create(libraryContext(ACTOR, CORRELATION), { kind: 'reusableSlide', title: 'Grace Slide' });
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'slide');
    expect(found).toMatchObject({ title: 'Grace Slide', explanation: 'matched the phrase in the title' });
  });

  it('slide: also matches a slide group, the library store\'s other slide kind', async () => {
    const { palette, library } = scenario();
    await library.create(libraryContext(ACTOR, CORRELATION), { kind: 'slideGroup', title: 'Grace Group' });
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'slide');
    expect(found).toMatchObject({ title: 'Grace Group', explanation: 'matched the phrase in the title' });
  });

  it('slideLayout: matches a Slide Layout on its name', async () => {
    const { palette, slideLayouts } = scenario();
    await slideLayouts.create(slideLayoutContext(ACTOR, CORRELATION), { name: 'Grace Layout', body: LAYOUT_BODY });
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'slideLayout');
    expect(found).toMatchObject({ title: 'Grace Layout', explanation: 'matched the phrase in the name' });
  });

  it('service: matches a Service on its title', async () => {
    const { palette, services } = scenario();
    await services.create(serviceContext(ACTOR, CORRELATION), serviceDraft('Grace Service'));
    const hits = await palette.search(ADMIN_SESSION, 'grace');
    const found = hits.find((entry) => entry.source === 'service');
    expect(found).toMatchObject({ title: 'Grace Service', explanation: 'matched the phrase in the title' });
  });
});

describe('paletteOn: a missing source fails the whole search (ruling 6)', () => {
  it('a scripture search failure rejects the whole call, tagged with its source', async () => {
    const { palette } = scenario(fakeCorpus({ failSearch: true }));
    const error = await refused(palette.search(ADMIN_SESSION, 'grace'));
    expect(error.source).toBe('scripture');
  });

  it('a non-corpus store failure rejects the whole call too, tagged with its own source', async () => {
    const { palette, db, songs } = scenario();
    const created = await songs.create(songContext(ACTOR, CORRELATION), 'Grace Song', {
      ...SONG,
      titles: { tamil: '', romanized: 'Grace Song' },
    });

    // Corrupt the stored revision behind the store's back, exactly as `revisions.ts`'s own doc comment
    // describes: a body changed outside the product is found on read rather than served, which is a
    // real `SongError` this `ranked()` catch branch has to wrap — not one contrived only for this test.
    const stored = db.rows.get('content_revisions') ?? [];
    const row = stored.find((entry) => entry['contentId'] === created.stamp.id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error('expected a stored revision to corrupt');
    row['body'] = { ...(row['body'] as Record<string, unknown>), titles: { tamil: '', romanized: 'Corrupted' } };

    const error = await refused(palette.search(ADMIN_SESSION, 'grace'));
    expect(error.source).toBe('song');
  });
});

describe('paletteOn: ranking (ruling 4)', () => {
  it('is deterministic, and breaks a tie on the fixed source order', async () => {
    const hit: CorpusSearchHit = {
      book: 'Romans', bookOrder: 6, chapter: 3, verse: 24, text: 'saved by grace', revision: 1, phrase: true, occurrences: 1,
    };
    const { palette, songs, library, slideLayouts, services } = scenario(fakeCorpus({ searchHits: [hit] }));
    await songs.create(songContext(ACTOR, CORRELATION), 'Amazing Grace', { ...SONG, titles: { tamil: '', romanized: 'Amazing Grace' } });
    await library.create(libraryContext(ACTOR, CORRELATION), { kind: 'reusableSlide', title: 'Grace Slide' });
    await slideLayouts.create(slideLayoutContext(ACTOR, CORRELATION), { name: 'Grace Layout', body: LAYOUT_BODY });
    await services.create(serviceContext(ACTOR, CORRELATION), serviceDraft('Grace Service'));

    const first = await palette.search(ADMIN_SESSION, 'grace');
    const second = await palette.search(ADMIN_SESSION, 'grace');

    expect(first.map((hit) => hit.source)).toEqual(['scripture', 'song', 'slide', 'slideLayout', 'service']);
    expect(second).toEqual(first);
  });

  it('ranks a higher occurrence count above an earlier source in the tiebreak order', async () => {
    const hit: CorpusSearchHit = {
      book: 'Hebrews', bookOrder: 19, chapter: 11, verse: 1, text: 'faith is the substance', revision: 1, phrase: true, occurrences: 1,
    };
    const { palette, songs } = scenario(fakeCorpus({ searchHits: [hit] }));
    await songs.create(songContext(ACTOR, CORRELATION), 'Faith Song', { ...SONG, titles: { tamil: '', romanized: 'Faith Faith Faith' } });

    const hits = await palette.search(ADMIN_SESSION, 'faith');

    expect(hits[0]).toMatchObject({ source: 'song', occurrences: 3 });
    expect(hits[1]).toMatchObject({ source: 'scripture', occurrences: 1 });
  });
});

describe('paletteOn: authorization filtering (ruling 3)', () => {
  it('a Member without layouts.manage never sees a Slide Layout hit, even a matching one', async () => {
    const { palette, slideLayouts } = scenario();
    await slideLayouts.create(slideLayoutContext(ACTOR, CORRELATION), { name: 'Banner Layout', body: LAYOUT_BODY });

    const memberHits = await palette.search(MEMBER_SESSION, 'banner');
    expect(memberHits.some((hit) => hit.source === 'slideLayout')).toBe(false);

    const adminHits = await palette.search(ADMIN_SESSION, 'banner');
    expect(adminHits.some((hit) => hit.source === 'slideLayout')).toBe(true);
  });

  it('song, slide, and service need only a session; reference, scripture, and slideLayout need more', async () => {
    const { palette, songs, library, services } = scenario();
    await songs.create(songContext(ACTOR, CORRELATION), 'Choir Song', { ...SONG, titles: { tamil: '', romanized: 'Choir Anthem' } });
    await library.create(libraryContext(ACTOR, CORRELATION), { kind: 'reusableSlide', title: 'Choir Slide' });
    await services.create(serviceContext(ACTOR, CORRELATION), serviceDraft('Choir Service'));

    const hits = await palette.search(BARE_SESSION, 'choir');

    expect(hits.map((hit) => hit.source).toSorted()).toEqual(['service', 'slide', 'song']);
  });
});

describe('paletteOn: Tamil and Romanized-Tamil normalization (ruling 5)', () => {
  const tamilTitle = 'தொழுவோம்'.normalize('NFD');

  const ammaSong: SongBody = { ...SONG, titles: { tamil: tamilTitle, romanized: 'Amma' } };

  it('a Tamil-script query matches Tamil-script text stored in a different Unicode normalization form', async () => {
    const { palette, songs } = scenario();
    await songs.create(songContext(ACTOR, CORRELATION), 'Amma Song', ammaSong);

    const hits = await palette.search(BARE_SESSION, 'தொழுவோம்'.normalize('NFC'));

    expect(hits.find((hit) => hit.source === 'song')).toMatchObject({ explanation: 'matched the phrase in the Tamil title' });
  });

  it('a Romanized-Tamil query matches Romanized-Tamil text stored with different case, vice versa', async () => {
    const { palette, songs } = scenario();
    await songs.create(songContext(ACTOR, CORRELATION), 'Amma Song', ammaSong);

    const hits = await palette.search(BARE_SESSION, 'amma');

    expect(hits.find((hit) => hit.source === 'song')).toMatchObject({ explanation: 'matched the phrase in the romanized title' });
  });
});

describe('paletteOn: a reference query with nothing to say contributes no hit, not a failure (JC3)', () => {
  it('a reference that parses but the canon does not hold contributes no hit', async () => {
    const { palette } = scenario(fakeCorpus({}));

    const hits = await palette.search(ADMIN_SESSION, 'John 3:16');

    expect(hits.some((hit) => hit.source === 'reference')).toBe(false);
  });

  it('a query that does not parse as a reference at all contributes no hit either', async () => {
    const { palette } = scenario(fakeCorpus({}));

    const hits = await palette.search(ADMIN_SESSION, 'not a reference at all');

    expect(hits.some((hit) => hit.source === 'reference')).toBe(false);
  });
});

describe('paletteOn: the strongest field wins, not merely the first that matches', () => {
  it('a lower-priority field\'s phrase match outranks a higher-priority field\'s scattered one', async () => {
    const { palette, songs } = scenario();
    // The Tamil title (checked first) only scatters "hope" and "faith"; the romanized title (checked
    // second) has them together as a phrase. First-match-wins would have reported the scattered match.
    await songs.create(songContext(ACTOR, CORRELATION), 'Hope and Faith', {
      ...SONG,
      titles: { tamil: 'hope shines through anointed with faith', romanized: 'Hope Faith Anthem' },
    });

    const hits = await palette.search(BARE_SESSION, 'hope faith');
    const found = hits.find((hit) => hit.source === 'song');

    expect(found).toMatchObject({ explanation: 'matched the phrase in the romanized title', phrase: true, occurrences: 1 });
  });
});
