// How many content items use each content language and each slide label (spec v1c-09, COLAB-13/14).
//
// Counted from the fields that actually name them, never from a body's serialized text: a song "uses"
// Tamil when its `languages` list says `ta`, not when the letters "ta" appear anywhere in it — which,
// for a two-letter key, is nearly every body there is. Languages are read from a song's declared
// `languages`, a sermon's `languages` map and every slide's language blocks; labels from a song
// section's `label` and a slide's `label`, both of which hold the label's *name* (the editors offer the
// catalogue as suggestions, and the text is what is saved), compared case- and space-insensitively.
//
// One item counts once however many of its sections or slides carry the name: the question an Admin
// asks before archiving is "how many things will show this", not "how many places".
//
// Not indexed: the body lives in the revision store, keyed by content id and sequence, and "the current
// revision of every item" is a latest-per-group read that store does not offer as a query. What is read
// here is exactly what the Content Library reads to list the same items, once per call, and a church's
// library is hundreds of items, not millions.

import { libraryContext } from './library.js';
import { sermonContext } from './sermons.js';
import { slideGroupContext } from './slide-groups.js';
import { songContext } from './songs.js';

import type { LibraryStore } from './library.js';
import type { SermonStore } from './sermons.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SongStore } from './songs.js';

export interface UsageStores {
  readonly library: LibraryStore;
  readonly songs: SongStore;
  readonly slideGroups: SlideGroupStore;
  /** Absent in a deployment without sermons, which then has no sermon to count. */
  readonly sermons?: SermonStore | undefined;
}

export interface ContentUsage {
  /** Items per content-language key. A key no item uses is absent: read it as zero. */
  readonly languages: ReadonlyMap<string, number>;
  /** Items per slide-label name, as `labelKey()` spells it. */
  readonly labels: ReadonlyMap<string, number>;
}

/** How a label name is compared: what an editor would call the same label, whatever its spacing or case. */
export const labelKey = (name: string): string => name.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');

const tally = (counts: Map<string, number>, keys: Iterable<string>): void => {
  for (const key of new Set(keys)) counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Reads every current song, sermon and slide group once and counts what each names. */
export async function contentUsage(stores: UsageStores, actor: string, correlationId: string): Promise<ContentUsage> {
  const languages = new Map<string, number>();
  const labels = new Map<string, number>();
  const rows = await stores.library.list(libraryContext(actor, correlationId));

  await Promise.all(
    rows.map(async ({ stamp }) => {
      if (stamp.kind === 'song') {
        const record = await stores.songs.current(songContext(actor, correlationId), stamp.id);
        if (record === undefined) return;
        tally(languages, record.body.languages);
        tally(labels, record.body.sections.map((section) => labelKey(section.label)).filter((key) => key !== ''));
      } else if (stamp.kind === 'slideGroup' || stamp.kind === 'reusableSlide') {
        const record = await stores.slideGroups.current(slideGroupContext(actor, correlationId), stamp.id);
        if (record === undefined) return;
        tally(languages, record.body.slides.flatMap((slide) => slide.languageBlocks.map((block) => block.languageKey)));
        tally(labels, record.body.slides.map((slide) => labelKey(slide.label)).filter((key) => key !== ''));
      } else if (stamp.kind === 'sermon' && stores.sermons !== undefined) {
        const record = await stores.sermons.current(sermonContext(actor, correlationId), stamp.id);
        if (record === undefined) return;
        tally(languages, Object.keys(record.body.languages));
      }
    }),
  );

  return { languages, labels };
}
