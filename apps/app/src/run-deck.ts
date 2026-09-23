// A run deck is derived from the immutable prepared manifest and its pinned slide-group revisions, never
// persisted beside them. Persisting it would duplicate content that can be reproduced exactly and could
// drift from the snapshot; changing PreparedSnapshot persistence is deliberately outside this module.

import type { LivePosition, LiveState } from '@holydeck/contracts/live-state';
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
  readonly notes?: string;
  readonly key?: string;
  readonly languages?: readonly string[];
  readonly audio?: unknown;
  /** Control's deck names who added an item; every other view gets the provenance without the account. */
  readonly provenance?: MidServiceProvenance | Omit<MidServiceProvenance, 'actor'>;
};

export type RunDeck = {
  readonly snapshotId: string;
  readonly pinnedRevisions: PreparedSnapshot['pins'];
  readonly aspectRatio: string;
  readonly safeAreaMargins: SafeAreaMargins;
  /** RUN-04: the screens `standby` may put up, resolved against the snapshot as a whole rather than
   *  whichever item happens to be selected. PreparedSnapshot pins no standby slide groups or media yet,
   *  and changing its persistence is outside this spec, so this is empty and every standby falls back
   *  to the empty screen until a snapshot can carry them (D-PLAN-10). */
  readonly standbyScreens: readonly DeckSlide[];
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
    standbyScreens: [],
    items: [...generated.filter((item): item is DeckItem => item !== undefined), ...additions.map(additionItem)],
  };
  decks.set(cacheKey, deck);
  return deck;
}

// D-PLAN-09. An account id is operator-only data: no view but Control is told who added an item, and
// Audience and Singer (both reachable by a guest ticket) also lose the notes, key and audio track the
// stage crew work from. Stage keeps those three: it is the band's screen, never a guest's.
const withoutAccount = (item: DeckItem): DeckItem => {
  if (item.provenance === undefined || !('actor' in item.provenance)) return item;
  const { actor, ...provenance } = item.provenance;
  void actor;
  return { ...item, provenance };
};

const withoutPrivateFields = (item: DeckItem): DeckItem => {
  const { notes, key, audio, ...projected } = withoutAccount(item);
  void notes;
  void key;
  void audio;
  return projected;
};

/** The audience deck runs up to and including the public next slide and no further (RUN-09): nothing
 *  unshown past it reaches a projector or a guest's phone. Standby, the empty screen, or a public
 *  position the deck does not hold windows it to nothing. The window moves with the public position,
 *  so the deck route's ETag does too — an audience client revalidates on each public change. */
const audienceWindow = (deck: RunDeck, live: Pick<LiveState, 'public'> | undefined): readonly DeckItem[] => {
  if (live === undefined || 'standby' in live.public) return [];
  const current = live.public;
  const upcoming = adjacentPosition(deck, current, 'next');
  if (upcoming === undefined) return [];
  const window: DeckItem[] = [];
  for (const item of deck.items) {
    const last = item.itemId === upcoming.itemId ? upcoming.slideIndex : item.slides.length - 1;
    if (last >= 0) window.push({ ...item, slides: item.slides.slice(0, last + 1) });
    if (item.itemId === upcoming.itemId) break;
  }
  return window;
};

export function projectDeck(deck: RunDeck, view: DeckView, live?: Pick<LiveState, 'public'>): RunDeck {
  if (view === 'control') return deck;
  if (view === 'stage') return { ...deck, items: deck.items.map(withoutAccount) };
  const items = view === 'audience' ? audienceWindow(deck, live) : deck.items;
  return { ...deck, items: items.map(withoutPrivateFields) };
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
