import { describe, expect, it } from 'vitest';

import { assemblePptxSections, pptxCommitOn } from './pptx-commit.js';
import { RECORDS } from './records.js';
import { SongError, songContext, songsOn } from './songs.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';
import type { SongTitles } from '@holydeck/contracts/songs';

import type { PptxCommit } from './pptx-commit.js';
import type { PptxReviewedBlock } from './pptx-review.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ACTOR = `account:${'E'.repeat(22)}`;

const ADMIN = songContext(ACTOR, 'req-pptx-commit');

const REVISIONS = RECORDS.contentRevisions.collection;

const STAMPS = RECORDS.contentLibrary.collection;

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const VERSE: SlideLabelEntry = { id: 'label-verse', name: 'Verse' };

const CHORUS: SlideLabelEntry = { id: 'label-chorus', name: 'Chorus' };

const stamp = (at: string): Pick<PptxReviewedBlock, 'at' | 'by'> => ({ at, by: ACTOR });

const store = (): { db: FakeDb; commit: PptxCommit; now: () => string } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const now = () => new Date(START + (tick += 1) * 1000).toISOString();
  return { db, now, commit: pptxCommitOn(db, { now, newId: () => `import-${(serial += 1)}` }) };
};

const TITLE: SongTitles = { tamil: 'பாடல்', romanized: 'Paadal' };

describe('assemblePptxSections', () => {
  it('turns each reviewed block into one section in slide/block order, regardless of input order', () => {
    const slides = [['first line', 'second line']];
    const reviewed: PptxReviewedBlock[] = [
      { slideIndex: 0, blockIndex: 1, label: CHORUS, ...stamp('t2') },
      { slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') },
    ];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.sections.map((section) => section.id)).toEqual(['import-1-0-0', 'import-1-0-1']);
    expect(assembly.sections.map((section) => section.label)).toEqual(['Verse', 'Chorus']);
  });

  it('splits Tamil and Latin runs into SectionText entries and derives languages from what was used', () => {
    const slides = [['அருமை grace']];
    const reviewed: PptxReviewedBlock[] = [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.sections).toEqual([
      {
        id: 'import-1-0-0',
        label: 'Verse',
        text: [
          { languageKey: 'ta', text: 'அருமை ' },
          { languageKey: 'ta-Latn', text: 'grace' },
        ],
      },
    ]);
    expect(assembly.languages).toEqual(['ta', 'ta-Latn']);
  });

  it('never declares a language nothing produced this call', () => {
    const slides = [['grace alone']];
    const reviewed: PptxReviewedBlock[] = [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.languages).toEqual(['ta-Latn']);
  });

  it('folds a repeat-marker block into the preceding section instead of making its own', () => {
    const slides = [['Amazing grace', 'x2']];
    const reviewed: PptxReviewedBlock[] = [
      { slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') },
      { slideIndex: 0, blockIndex: 1, label: CHORUS, ...stamp('t2') },
    ];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.sections).toHaveLength(1);
    expect(assembly.sections[0]?.id).toBe('import-1-0-0');
    expect(assembly.sections[0]?.repeat).toEqual({ count: 2 });
  });

  it('keeps the last marker when more than one targets the same section', () => {
    const slides = [['Amazing grace', 'x2', 'x3']];
    const reviewed: PptxReviewedBlock[] = [
      { slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') },
      { slideIndex: 0, blockIndex: 1, label: CHORUS, ...stamp('t2') },
      { slideIndex: 0, blockIndex: 2, label: CHORUS, ...stamp('t3') },
    ];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.sections).toHaveLength(1);
    expect(assembly.sections[0]?.repeat).toEqual({ count: 3 });
  });

  it('falls back to an ordinary section for a leading marker with nothing before it', () => {
    const slides = [['x2', 'Amazing grace']];
    const reviewed: PptxReviewedBlock[] = [
      { slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') },
      { slideIndex: 0, blockIndex: 1, label: CHORUS, ...stamp('t2') },
    ];

    const assembly = assemblePptxSections(slides, reviewed, 'import-1');

    expect(assembly.sections).toHaveLength(2);
    expect(assembly.sections[0]).toEqual({ id: 'import-1-0-0', label: 'Verse', text: [{ languageKey: 'ta-Latn', text: 'x2' }] });
    expect(assembly.sections[0]?.repeat).toBeUndefined();
  });

  it('folds a marker onto the append target’s own last existing section, not a section made this call', () => {
    const slides = [['x2']];
    const reviewed: PptxReviewedBlock[] = [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }];
    const existing = { languages: ['ta-Latn'], sections: [{ id: 'old-1', label: 'Verse 1', text: [] }] };

    const assembly = assemblePptxSections(slides, reviewed, 'import-1', existing);

    expect(assembly.sections).toHaveLength(1);
    expect(assembly.sections[0]).toEqual({ id: 'old-1', label: 'Verse 1', text: [], repeat: { count: 2 } });
  });

  it('preserves the target’s existing languages in order and appends only genuinely new ones after', () => {
    const slides = [['grace அருமை']];
    const reviewed: PptxReviewedBlock[] = [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }];
    const existing = { languages: ['ta-Latn'], sections: [] };

    const assembly = assemblePptxSections(slides, reviewed, 'import-1', existing);

    expect(assembly.languages).toEqual(['ta-Latn', 'ta']);
  });
});

describe('pptxCommitOn: create', () => {
  it('creates a new song with a section per reviewed block and import provenance', async () => {
    const { db, commit } = store();
    const slides = [['Amazing grace', 'how sweet the sound']];
    const reviewed: PptxReviewedBlock[] = [
      { slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') },
      { slideIndex: 0, blockIndex: 1, label: CHORUS, ...stamp('t2') },
    ];

    const created = await commit.commit(ADMIN, { mode: 'create', title: TITLE }, slides, reviewed);

    expect(created.title).toBe('Paadal');
    expect(created.body.titles).toEqual(TITLE);
    expect(created.body.sections).toHaveLength(2);
    expect(created.body.provenance).toEqual({
      source: 'import',
      importer: 'powerpoint',
      importedAt: expect.any(String),
      importId: 'import-1',
    });
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('carries an optional reference through provenance only when the caller supplied one', async () => {
    const { commit } = store();
    const slides = [['Amazing grace']];
    const reviewed: PptxReviewedBlock[] = [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }];

    const withReference = await commit.commit(
      ADMIN,
      { mode: 'create', title: TITLE, reference: 'set.pptx' },
      slides,
      reviewed,
    );
    expect(withReference.body.provenance).toMatchObject({ reference: 'set.pptx' });

    const withoutReference = await commit.commit(ADMIN, { mode: 'create', title: TITLE }, slides, reviewed);
    expect(withoutReference.body.provenance).not.toHaveProperty('reference');
  });
});

describe('pptxCommitOn: append', () => {
  const createBase = async (commit: PptxCommit) =>
    commit.commit(
      ADMIN,
      { mode: 'create', title: TITLE },
      [['Amazing grace']],
      [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }],
    );

  it('splices new sections onto the target without disturbing its existing revisions', async () => {
    const { db, commit } = store();
    const created = await createBase(commit);
    const historyBefore = await songsOn(db, { now: () => 'unused' }).history(ADMIN, created.stamp.id);

    const appended = await commit.commit(
      ADMIN,
      { mode: 'append', id: created.stamp.id },
      [['how sweet the sound']],
      [{ slideIndex: 0, blockIndex: 0, label: CHORUS, ...stamp('t2') }],
    );

    expect(appended.body.sections).toHaveLength(2);
    expect(appended.body.sections[0]?.id).toBe(created.body.sections[0]?.id);
    const historyAfter = await songsOn(db, { now: () => 'unused' }).history(ADMIN, created.stamp.id);
    expect(historyAfter).toHaveLength(historyBefore.length + 1);
    // The pre-append revision itself is unchanged: still reachable, still exactly what it was.
    expect(historyAfter[0]).toEqual(historyBefore[0]);
  });

  it('leaves the target’s existing provenance untouched on append', async () => {
    const { commit } = store();
    const created = await createBase(commit);

    const appended = await commit.commit(
      ADMIN,
      { mode: 'append', id: created.stamp.id },
      [['how sweet the sound']],
      [{ slideIndex: 0, blockIndex: 0, label: CHORUS, ...stamp('t2') }],
    );

    expect(appended.body.provenance).toEqual(created.body.provenance);
  });

  it('is reversible: the pre-append revision stays readable by number after the append', async () => {
    const { db, commit } = store();
    const created = await createBase(commit);
    const songs = songsOn(db, { now: () => 'unused' });

    await commit.commit(
      ADMIN,
      { mode: 'append', id: created.stamp.id },
      [['how sweet the sound']],
      [{ slideIndex: 0, blockIndex: 0, label: CHORUS, ...stamp('t2') }],
    );

    const original = await songs.current(ADMIN, created.stamp.id, created.revision);
    expect(original?.body).toEqual(created.body);
  });

  it('mints section ids that stay unique across two separate commit calls, even with repeated indices', async () => {
    const { commit } = store();
    const created = await createBase(commit);

    const appended = await commit.commit(
      ADMIN,
      { mode: 'append', id: created.stamp.id },
      [['second verse']],
      [{ slideIndex: 0, blockIndex: 0, label: CHORUS, ...stamp('t2') }],
    );

    const ids = appended.body.sections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['import-1-0-0', 'import-2-0-0']);
  });

  it('refuses to append onto a song that does not exist', async () => {
    const { commit } = store();

    const error = await commit
      .commit(ADMIN, { mode: 'append', id: 'nope' }, [['x']], [{ slideIndex: 0, blockIndex: 0, label: VERSE, ...stamp('t1') }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SongError);
    expect((error as SongError).kind).toBe('state');
  });
});
