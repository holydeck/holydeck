// A run deck is derived from the immutable prepared manifest and its pinned slide-group revisions, never
// persisted beside them. Persisting it would duplicate content that can be reproduced exactly and could
// drift from the snapshot; changing PreparedSnapshot persistence is deliberately outside this module.

import type { LivePosition } from '@holydeck/contracts/live-state';
import type { SafeAreaMargins, PreparedSnapshot } from '@holydeck/contracts/snapshots';

import type { MidServiceAddition } from './mid-service-additions.js';
import type { SlideGroupRecord, SlideGroupStore } from './slide-groups.js';

export type DeckSlide = {
  readonly slideId: string;
  readonly boxes: readonly unknown[];
};

export type MidServiceProvenance = {
  readonly origin: 'mid-service';
  readonly actor: string;
  readonly at: string;
};

export type DeckItem = {
  readonly itemId: string;
  readonly kind: string;
  readonly title: string;
  readonly slides: readonly DeckSlide[];
  readonly standbyScreens?: readonly DeckSlide[];
  readonly notes?: string;
  readonly key?: string;
  readonly languages?: readonly string[];
  readonly audio?: unknown;
  readonly provenance?: MidServiceProvenance;
};

export type RunDeck = {
  readonly snapshotId: string;
  readonly pinnedRevisions: PreparedSnapshot['pins'];
  readonly aspectRatio: string;
  readonly safeAreaMargins: SafeAreaMargins;
  readonly items: readonly DeckItem[];
};

export type DeckView = 'audience' | 'stage' | 'singer' | 'control';

export interface DeckStores {
  readonly slideGroups: Pick<SlideGroupStore, 'history'>;
}

const decks = new Map<string, RunDeck>();

const itemFrom = (record: SlideGroupRecord): DeckItem => {
  const slides = record.body.slides
    .filter((slide) => slide.enabled)
    .map((slide) => ({ slideId: slide.id, boxes: slide.languageBlocks }));
  const languages = [...new Set(
    record.body.slides.flatMap((slide) => slide.enabled ? slide.languageBlocks.map((block) => block.languageKey) : []),
  )];
  return {
    itemId: record.stamp.id,
    kind: record.stamp.kind,
    title: record.title,
    slides,
    ...(languages.length === 0 ? {} : { languages }),
    ...(record.body.audioTrackId === undefined ? {} : { audio: record.body.audioTrackId }),
  };
};

const additionItem = (addition: MidServiceAddition): DeckItem => ({
  itemId: addition.contentId,
  kind: 'mid-service',
  title: addition.contentId,
  slides: [],
  provenance: { origin: 'mid-service', actor: addition.actor, at: addition.at },
});

export async function deriveDeck(
  context: unknown,
  stores: DeckStores,
  snapshot: PreparedSnapshot,
  additions: readonly MidServiceAddition[],
): Promise<RunDeck> {
  const cacheKey = `${snapshot.id}:${additions.length}`;
  const cached = decks.get(cacheKey);
  if (cached !== undefined) return cached;

  const generated = await Promise.all(snapshot.generatedSlides.map(async (provenance) => {
    const history = await stores.slideGroups.history(context, provenance.slideGroupId);
    const pinned = history[provenance.slideGroupRevision - 1];
    if (pinned === undefined) {
      throw new Error(`${provenance.slideGroupId} has no slide group revision ${provenance.slideGroupRevision}`);
    }
    return pinned.body.mode === 'generated' && pinned.body.enabled ? itemFrom(pinned) : undefined;
  }));
  const deck: RunDeck = {
    snapshotId: snapshot.id,
    pinnedRevisions: snapshot.pins,
    aspectRatio: snapshot.resolved.aspectRatio,
    safeAreaMargins: snapshot.resolved.safeAreaMargins,
    items: [...generated.filter((item): item is DeckItem => item !== undefined), ...additions.map(additionItem)],
  };
  decks.set(cacheKey, deck);
  return deck;
}

const withoutPrivateFields = (item: DeckItem): DeckItem => {
  const { notes, key, ...projected } = item;
  void notes;
  void key;
  return projected;
};

export function projectDeck(deck: RunDeck, view: DeckView): RunDeck {
  if (view === 'control' || view === 'stage') return deck;
  return { ...deck, items: deck.items.map(withoutPrivateFields) };
}

export function adjacentPosition(
  deck: RunDeck,
  current: LivePosition,
  direction: 'next' | 'previous',
): LivePosition | undefined {
  const positions = deck.items.flatMap((item) =>
    item.slides.map((_, slideIndex) => ({ itemId: item.itemId, slideIndex })),
  );
  const index = positions.findIndex((position) =>
    position.itemId === current.itemId && position.slideIndex === current.slideIndex,
  );
  if (index === -1) return undefined;
  return positions[index + (direction === 'next' ? 1 : -1)] ?? current;
}
