import { describe, expect, it } from 'vitest';

import { adjacentPosition, deriveDeck, projectDeck } from './run-deck.js';

import type { PreparedSnapshot, SnapshotPin } from '@holydeck/contracts/snapshots';

import type { MidServiceAddition } from './mid-service-additions.js';
import type { DeckItem, RunDeck } from './run-deck.js';
import type { SlideGroupRecord, SlideGroupStore } from './slide-groups.js';

const AT = '2026-09-22T09:30:00.000Z';
const ACTOR = 'account:operator';

const record = (enabled: boolean): SlideGroupRecord => ({
  stamp: {
    id: 'group-1',
    kind: 'slideGroup',
    schemaVersion: 1,
    createdAt: AT,
    createdBy: ACTOR,
    updatedAt: AT,
    updatedBy: ACTOR,
    archivedAt: undefined,
    archivedBy: undefined,
  },
  title: 'Amazing Grace',
  body: {
    mode: 'generated',
    enabled,
    slideLayoutId: 'layout-1',
    slides: [
      {
        id: 'slide-1',
        enabled: true,
        label: 'Verse 1',
        languageBlocks: [{ id: 'lyrics', languageKey: 'ta', text: 'அருள்' }],
      },
      {
        id: 'slide-2',
        enabled: false,
        label: 'Hidden verse',
        languageBlocks: [{ id: 'lyrics', languageKey: 'ta', text: 'மறைந்தது' }],
      },
    ],
  },
});

const snapshot = (id = 'snapshot-run-deck'): PreparedSnapshot => ({
  id,
  pins: Object.fromEntries(
    ['service', 'content', 'slideLayout', 'serviceTemplate', 'settings', 'media', 'corpus']
      .map((pin) => [pin, `${pin}@1`]),
  ) as Record<SnapshotPin, string>,
  resolved: {
    aspectRatio: '16:9',
    safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  },
  generatedSlides: [{
    slideGroupId: 'group-1',
    slideGroupRevision: 1,
    sourceId: 'song-1',
    sourceRevision: 2,
    slideLayoutId: 'layout-1',
    slideLayoutRevision: 3,
  }],
  immutable: true,
});

const slideGroups = (history: readonly SlideGroupRecord[] = [record(true)]): Pick<SlideGroupStore, 'history'> => ({
  history: async () => history,
});

describe('deriveDeck', () => {
  it('derives one deck item per pinned, enabled generated slide group', async () => {
    const deck = await deriveDeck({}, { slideGroups: slideGroups([record(true), record(false)]) }, snapshot(), []);

    expect(deck).toEqual({
      snapshotId: 'snapshot-run-deck',
      pinnedRevisions: snapshot().pins,
      aspectRatio: '16:9',
      safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
      // RUN-04 resolves standby against the snapshot's own screens; today's PreparedSnapshot pins none.
      standbyScreens: [],
      items: [{
        itemId: 'group-1',
        kind: 'slideGroup',
        title: 'Amazing Grace',
        slides: [{
          slideId: 'slide-1',
          boxes: [{ id: 'lyrics', languageKey: 'ta', text: 'அருள்' }],
        }],
        languages: ['ta'],
      }],
    });
  });

  it('includes a mid-service addition as a deck item with mid-service provenance', async () => {
    const addition: MidServiceAddition = {
      contentId: 'addition-1',
      runId: 'run-1',
      actor: ACTOR,
      at: AT,
    };

    const deck = await deriveDeck({}, { slideGroups: slideGroups() }, snapshot('snapshot-with-addition'), [addition]);

    expect(deck.items.at(-1)).toEqual({
      itemId: 'addition-1',
      kind: 'mid-service',
      title: 'addition-1',
      slides: [],
      provenance: { origin: 'mid-service', actor: ACTOR, at: AT },
    });
  });

  it('memoises by snapshotId + additionsRevision: a second call with the same inputs returns the same object reference', async () => {
    const prepared = snapshot('snapshot-memoised');
    const stores = { slideGroups: slideGroups() };

    const first = await deriveDeck({}, stores, prepared, []);
    const second = await deriveDeck({}, stores, prepared, []);

    expect(second).toBe(first);
  });
});

describe('projectDeck', () => {
  const privateItem: DeckItem = {
    itemId: 'item-1',
    kind: 'song',
    title: 'Amazing Grace',
    slides: [{ slideId: 'slide-1', boxes: [{ text: 'lyrics' }] }],
    notes: 'Repeat the chorus',
    key: 'G',
    languages: ['ta'],
  };
  const deck: RunDeck = {
    snapshotId: 'snapshot-private',
    pinnedRevisions: snapshot().pins,
    aspectRatio: '16:9',
    safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
    standbyScreens: [],
    items: [privateItem],
  };

  it('strips notes and key from the audience and singer projections but keeps them on stage', () => {
    for (const view of ['audience', 'singer'] as const) {
      const projected = projectDeck(deck, view);
      expect(projected.items[0]).not.toHaveProperty('notes');
      expect(projected.items[0]).not.toHaveProperty('key');
      expect(projected.items[0]).toMatchObject({ languages: ['ta'], slides: privateItem.slides });
      expect(JSON.stringify(projected)).not.toContain('Repeat the chorus');
    }

    expect(projectDeck(deck, 'stage').items[0]).toMatchObject({ notes: 'Repeat the chorus', key: 'G' });
  });

  it('control projection is the deck unchanged', () => {
    expect(projectDeck(deck, 'control')).toBe(deck);
  });
});

describe('adjacentPosition', () => {
  const deck: RunDeck = {
    snapshotId: 'navigation', pinnedRevisions: snapshot().pins, aspectRatio: '16:9', safeAreaMargins: snapshot().resolved.safeAreaMargins,
    standbyScreens: [],
    items: [0, 2, 0, 1, 0].map((count, index) => ({
      itemId: `item-${index}`, kind: 'song', title: 'Song',
      slides: Array.from({ length: count }, (_, slide) => ({ slideId: `slide-${slide}`, boxes: [] })),
    })),
  };

  it.each([
    ['item-1', 0, 'next', 'item-1', 1],
    ['item-1', 1, 'next', 'item-3', 0],
    ['item-3', 0, 'previous', 'item-1', 1],
    ['item-1', 1, 'previous', 'item-1', 0],
    ['item-1', 0, 'previous', 'item-1', 0],
    ['item-3', 0, 'next', 'item-3', 0],
  ] as const)('navigates %s:%s %s to %s:%s', (itemId, slideIndex, direction, target, index) => {
    expect(adjacentPosition(deck, { itemId, slideIndex }, direction)).toEqual({ itemId: target, slideIndex: index });
  });

  it.each([['missing', 0], ['item-2', 0], ['item-1', 2], ['item-1', -1]])('refuses absent position %s:%s', (itemId, slideIndex) => {
    expect(adjacentPosition(deck, { itemId: String(itemId), slideIndex: Number(slideIndex) }, 'next')).toBeUndefined();
  });
});
