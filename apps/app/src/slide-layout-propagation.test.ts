import { describe, expect, it } from 'vitest';

import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { isOutdated, OUTDATED_REQUIRES, resolutionFor } from './slide-layout-propagation.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SlideLayoutBody } from '@holydeck/contracts/layouts';

import type { SlideLayoutStore } from './slide-layouts.js';
import type { LayoutConsumer, LayoutResolution } from './slide-layout-propagation.js';

const ADMINISTRATOR = `account:${'D'.repeat(22)}`;

const ADMIN = slideLayoutContext(ADMINISTRATOR, 'req-40-propagation');

const text = {
  id: 'lyric',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' },
  style: {
    fontFamily: 'Inter',
    fontWeight: 600,
    sizeRatio: 0.08,
    lineHeight: 1.25,
    align: 'center',
    verticalAlign: 'center',
  },
} as const;

const backdrop = {
  id: 'backdrop',
  kind: 'media',
  importance: 'decoration',
  frame: { x: 0, y: 0, width: 1, height: 1 },
  style: { fit: 'cover', opacity: 0.4 },
} as const;

const ONE: SlideLayoutBody = { boxes: [text] };

const TWO: SlideLayoutBody = { boxes: [backdrop, text] };

const store = (): SlideLayoutStore => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return slideLayoutsOn(db, {
    now: () => new Date(Date.parse('2026-09-17T09:00:00.000Z') + (tick += 1) * 1000 - 1000).toISOString(),
    newId: () => `layout-${(serial += 1)}`,
  });
};

describe('resolutionFor', () => {
  const table: readonly [LayoutConsumer, LayoutResolution][] = [
    ['unpreparedRendering', 'current'],
    ['preparedSnapshot', 'pinned'],
    ['activeRun', 'pinned'],
    ['historicalRunLog', 'pinned'],
    ['contentRevisions', 'not-applicable'],
  ];

  it.each(table)('resolves %s as %s, per ADR 0005', (consumer, resolution) => {
    expect(resolutionFor(consumer)).toBe(resolution);
  });
});

describe('isOutdated', () => {
  it('is false while the pinned revision still matches the current one', () => {
    expect(isOutdated(1, 1)).toBe(false);
  });

  it('is true once the current revision has moved past the pinned one', () => {
    expect(isOutdated(1, 2)).toBe(true);
  });
});

describe('OUTDATED_REQUIRES', () => {
  it('names exactly regeneration and revalidation, frozen', () => {
    expect(OUTDATED_REQUIRES).toEqual(['regeneration', 'revalidation']);
    expect(Object.isFrozen(OUTDATED_REQUIRES)).toBe(true);
  });
});

describe('composes with the existing revision rules', () => {
  it("a pinned preview's body and revision stay unchanged after the Layout is edited further, while the current preview and isOutdated both move", async () => {
    const layouts = store();
    const created = await layouts.create(ADMIN, { name: 'Sermon point', body: ONE });
    const pinnedRevision = created.revision;

    const beforeEdit = await layouts.preview(ADMIN, created.stamp.id, pinnedRevision);
    expect(isOutdated(pinnedRevision, beforeEdit?.revision ?? -1)).toBe(false);

    await layouts.version(ADMIN, created.stamp.id, TWO);

    // A consumer holding this pinned revision — prepared snapshot, active run, or historical run log — is
    // unaffected by the edit: same mechanism (`preview` with an explicit revision) serves all three.
    const pinned = await layouts.preview(ADMIN, created.stamp.id, pinnedRevision);
    expect(pinned?.body).toEqual(ONE);
    expect(pinned?.revision).toBe(pinnedRevision);

    // Unprepared rendering (omitted revision) propagates automatically to the edit.
    const current = await layouts.preview(ADMIN, created.stamp.id);
    expect(current?.body).toEqual(TWO);
    expect(current?.revision).not.toBe(pinnedRevision);

    // A snapshot that pinned the old revision is now Outdated.
    expect(isOutdated(pinnedRevision, current?.revision ?? pinnedRevision)).toBe(true);
  });
});
