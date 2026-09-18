import { describe, expect, it } from 'vitest';

import { slideLabelContext, slideLabelsOn } from './slide-labels.js';
import { PptxReviewError, gradePptxReview, pptxReviewOn } from './pptx-review.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';
import type { PptxReviewDecision } from './pptx-review.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ACTOR = `account:${'D'.repeat(22)}`;

const ADMIN = slideLabelContext(ACTOR, 'req-pptx-review');

const LIVE: readonly SlideLabelEntry[] = [
  { id: 'label-1', name: 'Verse', shortcut: '1' },
  { id: 'label-2', name: 'Chorus' },
];

const STAMP = { at: '2026-09-17T09:30:05.000Z', by: ACTOR };

describe('gradePptxReview', () => {
  it('reviews every block once every one names a label the catalogue offers', () => {
    const slides = [['Amazing grace', 'how sweet the sound'], ['second verse']];
    const decisions: PptxReviewDecision[] = [
      { slideIndex: 0, blockIndex: 0, label: 'Verse' },
      { slideIndex: 0, blockIndex: 1, label: 'Chorus' },
      { slideIndex: 1, blockIndex: 0, label: 'Verse' },
    ];

    const grade = gradePptxReview(slides, decisions, LIVE, STAMP);

    expect(grade.ok).toBe(true);
    if (!grade.ok) throw new Error('expected the grade to be ok');
    expect(grade.reviewed).toEqual([
      { slideIndex: 0, blockIndex: 0, label: LIVE[0], at: STAMP.at, by: STAMP.by },
      { slideIndex: 0, blockIndex: 1, label: LIVE[1], at: STAMP.at, by: STAMP.by },
      { slideIndex: 1, blockIndex: 0, label: LIVE[0], at: STAMP.at, by: STAMP.by },
    ]);
  });

  it('refuses to commit while a block has no reviewed decision, naming exactly which one', () => {
    const slides = [['Amazing grace', 'how sweet the sound']];
    const decisions: PptxReviewDecision[] = [{ slideIndex: 0, blockIndex: 0, label: 'Verse' }];

    const grade = gradePptxReview(slides, decisions, LIVE, STAMP);

    expect(grade.ok).toBe(false);
    if (grade.ok) throw new Error('expected the grade to be refused');
    expect(grade.problems).toEqual([
      { kind: 'unreviewed', slideIndex: 0, blockIndex: 1, message: expect.any(String) },
    ]);
  });

  it('refuses a decision naming a label outside the live catalogue', () => {
    const slides = [['Amazing grace']];
    const decisions: PptxReviewDecision[] = [{ slideIndex: 0, blockIndex: 0, label: 'Bridge' }];

    const grade = gradePptxReview(slides, decisions, LIVE, STAMP);

    expect(grade.ok).toBe(false);
    if (grade.ok) throw new Error('expected the grade to be refused');
    expect(grade.problems).toEqual([
      { kind: 'unknown-label', slideIndex: 0, blockIndex: 0, message: expect.any(String) },
    ]);
  });

  it('reports every unreviewed block and every unknown-label decision at once, not just the first', () => {
    const slides = [['a', 'b'], ['c']];
    const decisions: PptxReviewDecision[] = [{ slideIndex: 0, blockIndex: 0, label: 'Bridge' }];

    const grade = gradePptxReview(slides, decisions, LIVE, STAMP);

    expect(grade.ok).toBe(false);
    if (grade.ok) throw new Error('expected the grade to be refused');
    expect(grade.problems).toEqual([
      { kind: 'unknown-label', slideIndex: 0, blockIndex: 0, message: expect.any(String) },
      { kind: 'unreviewed', slideIndex: 0, blockIndex: 1, message: expect.any(String) },
      { kind: 'unreviewed', slideIndex: 1, blockIndex: 0, message: expect.any(String) },
    ]);
  });

  it('is unmoved by a decision naming a block no slide has', () => {
    const slides = [['Amazing grace']];
    const decisions: PptxReviewDecision[] = [
      { slideIndex: 0, blockIndex: 0, label: 'Verse' },
      { slideIndex: 0, blockIndex: 1, label: 'Chorus' },
    ];

    const grade = gradePptxReview(slides, decisions, LIVE, STAMP);

    expect(grade.ok).toBe(true);
    if (!grade.ok) throw new Error('expected the grade to be ok');
    expect(grade.reviewed).toEqual([{ slideIndex: 0, blockIndex: 0, label: LIVE[0], at: STAMP.at, by: STAMP.by }]);
  });

  it('refuses with no blocks reviewed when nothing was decided at all', () => {
    const slides = [['only block']];

    const grade = gradePptxReview(slides, [], LIVE, STAMP);

    expect(grade.ok).toBe(false);
    if (grade.ok) throw new Error('expected the grade to be refused');
    expect(grade.problems).toEqual([{ kind: 'unreviewed', slideIndex: 0, blockIndex: 0, message: expect.any(String) }]);
  });
});

const store = (): { db: FakeDb; now: () => string } => {
  const db = fakeDb();
  let tick = 0;
  return { db, now: () => new Date(START + (tick += 1) * 1000).toISOString() };
};

const LABELS = 'slide_labels';

const rows = (db: FakeDb): Document[] => db.rows.get(LABELS) ?? [];

describe('pptxReviewOn', () => {
  it('grades decisions against the live T52 catalogue, stamped with actor and time', async () => {
    const { db, now } = store();
    await slideLabelsOn(db, { now }).create(ADMIN, { name: 'Verse', shortcut: '1' });
    const review = pptxReviewOn(db, { now });

    const reviewed = await review.review(ADMIN, [['Amazing grace']], [{ slideIndex: 0, blockIndex: 0, label: 'Verse' }]);

    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({ slideIndex: 0, blockIndex: 0, by: ACTOR });
    expect(reviewed[0]?.label).toMatchObject({ name: 'Verse', shortcut: '1' });
    expect(typeof reviewed[0]?.at).toBe('string');
  });

  it('refuses to commit an import with an unreviewed block, naming it on the error', async () => {
    const { db, now } = store();
    await slideLabelsOn(db, { now }).create(ADMIN, { name: 'Verse' });
    const review = pptxReviewOn(db, { now });
    const before = rows(db).length;

    const error = await review
      .review(ADMIN, [['a', 'b']], [{ slideIndex: 0, blockIndex: 0, label: 'Verse' }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PptxReviewError);
    expect((error as PptxReviewError).kind).toBe('unreviewed');
    expect((error as PptxReviewError).problems).toEqual([
      { kind: 'unreviewed', slideIndex: 0, blockIndex: 1, message: expect.any(String) },
    ]);
    // Nothing is persisted by this gate: reviewing writes no new row, win or lose.
    expect(rows(db)).toHaveLength(before);
  });

  it('refuses a decision naming a label the catalogue does not currently offer', async () => {
    const { db, now } = store();
    await slideLabelsOn(db, { now }).create(ADMIN, { name: 'Verse' });
    const review = pptxReviewOn(db, { now });

    const error = await review
      .review(ADMIN, [['a']], [{ slideIndex: 0, blockIndex: 0, label: 'Not a real label' }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PptxReviewError);
    expect((error as PptxReviewError).kind).toBe('unknown-label');
  });

  it('refuses a decision naming a label that has since been archived', async () => {
    const { db, now } = store();
    const labels = slideLabelsOn(db, { now });
    const verse = await labels.create(ADMIN, { name: 'Verse' });
    await labels.archive(ADMIN, verse.stamp.id);
    const review = pptxReviewOn(db, { now });

    const error = await review
      .review(ADMIN, [['a']], [{ slideIndex: 0, blockIndex: 0, label: 'Verse' }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PptxReviewError);
    expect((error as PptxReviewError).kind).toBe('unknown-label');
  });
});
