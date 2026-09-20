// What the Stage surface knows that no other surface does (LIVE-17): it looks further ahead than the
// slide being shown, it may show the song key, and the language it reads in is its own to choose.
//
// Look-ahead here is not `control-state.ts`'s. `previewPositions` resolves current and next inside one
// item's own slide order and stops at that item's last slide, which is the right answer for the operator
// panel it was written for. The musician reading Stage needs the answer the service has rather than the
// answer one item has: when the last slide of a song is up, what is coming is the first slide of the
// item after it. So this module's position is a pair — which item, and which slide of it — and `next`
// crosses the boundary, skipping an item that carries no slides because an item with nothing to show is
// not something anyone can be shown next. The one thing that does not change is the end: the last slide
// of the last item has no next, and never wraps around to the first, for the same reason stated in
// `control-state.ts` — a service that has run out is a real state to show honestly.
//
// The song key is optional and injected, and this module never reaches for a source for it. No persisted
// shape in this build carries one: §12.4 limits song metadata to author and copyright, and `songs.ts`
// holds the schema to exactly that. LIVE-17 says Stage *may* show the key, so what is settled here is
// the display rule alone — present it when whatever assembles an item has one, and leave the field off
// the cue entirely when it does not, rather than rendering an empty line or a placeholder where a key
// would be. The day a key has somewhere to live, it arrives through `StageItem.key` and nothing below
// changes.
//
// The language Stage reads in is one of the song's own declared content languages — `songs.ts`'s
// `languages` list, graded against the registry in `content-languages.ts`. It is not `Locale`, which is
// the app's own chrome translation and a different axis entirely: an operator running the app in one
// interface language can have Stage reading Tamil while Audience reads the romanization. That is what
// makes the choice Stage-*local*: `selectStageLanguage` writes one field of the per-surface record and
// is structurally incapable of moving Audience's or Singer's, which is the guarantee LIVE-17 asks for.

import { isContentLanguageKey } from '@holydeck/contracts/content-languages';

import type { OutputChannel } from '@holydeck/contracts/live';

/** One slide's words, keyed by the content language they are written in — the same keying `songs.ts`
 *  gives a section's text, reduced to what a surface needs to render one slide. A language a slide has
 *  no entry for is a slide nobody has translated yet, which `songs.ts` explicitly permits. */
export type StageSlide = Readonly<Record<string, string>>;

/**
 * The minimum an item has to say about itself for Stage to look ahead onto it. Deliberately not
 * `ServiceItem`: like `control-state.ts`'s `OrderItem`, this is the reduced shape the rules below are
 * provable against, so nothing here depends on how a song, a reading or a slide group is stored.
 */
export interface StageItem {
  readonly id: string;
  readonly title: string;
  /** This item's own slides. Their count is the length look-ahead runs out of before it crosses into
   *  the item after this one; an item with none of them is passed over rather than stopped at. */
  readonly slides: readonly StageSlide[];
  /** The content languages this item declares, in its own order. The first is what a surface reads when
   *  it has expressed no preference, or expressed one this item never offered. */
  readonly languages: readonly string[];
  /** The musical key, when whatever assembled this item had one — see the header on why it is injected
   *  and optional rather than read from a persisted field. */
  readonly key?: string;
}

/** Where a surface is in a whole service, rather than in one item: which item, and which slide of it. */
export interface StagePosition {
  readonly item: number;
  readonly slide: number;
}

/** What any output surface renders for one position. `languageKey` is which of the item's own languages
 *  this surface ended up reading it in, and is `undefined` only for an item that declares none. */
export interface SurfaceCue {
  readonly position: StagePosition;
  readonly title: string;
  readonly languageKey: string | undefined;
  readonly text: string;
}

/** A Stage cue: everything the other surfaces render, plus the one field only Stage shows. `key` is
 *  absent — not empty, not a placeholder — for an item that carries no key. */
export interface StageCue extends SurfaceCue {
  readonly key?: string;
}

/** The slide Stage is on and the one after it, either of which can be absent: an empty service has
 *  neither, and the end of the last item has no next. */
export interface StageLookAhead {
  readonly current: StageCue | undefined;
  readonly next: StageCue | undefined;
}

/** Which content language each output surface is reading the same live content in. Keyed by
 *  `OutputChannel` so the three surfaces are named once, by the contract that already names them. */
export type SurfaceLanguages = Readonly<Record<OutputChannel, string | undefined>>;

const clamp = (value: number, length: number): number => Math.min(Math.max(value, 0), length - 1);

/** A real slide of a real item, resolved once and carried together, so nothing below has to look the
 *  item up a second time and then guard against a lookup that already succeeded. */
interface StageStop {
  readonly position: StagePosition;
  readonly item: StageItem;
}

const stopAt = (items: readonly StageItem[], position: StagePosition): StageStop | undefined => {
  if (items.length === 0) return undefined;
  const index = clamp(position.item, items.length);
  const item = items[index];
  if (item === undefined || item.slides.length === 0) return undefined;
  return { position: { item: index, slide: clamp(position.slide, item.slides.length) }, item };
};

/**
 * The position a surface is really at, with an item or slide index out of range clamped to the nearest
 * real one — `previewPositions`' rule, extended to the item axis. `undefined` for a service with no
 * items, and for an item that carries no slides: there is no slide to be at, which is different from
 * being at a slide that happens to be blank.
 */
export function resolveStagePosition(
  items: readonly StageItem[],
  position: StagePosition,
): StagePosition | undefined {
  return stopAt(items, position)?.position;
}

/**
 * The slide after this one anywhere in the service: the next slide of this item while it has one, and
 * otherwise the first slide of the next item that has any. `undefined` at the end of the last item —
 * there is no wraparound, and an item with no slides is never offered as what is coming next.
 */
export function nextStagePosition(
  items: readonly StageItem[],
  position: StagePosition,
): StagePosition | undefined {
  const here = stopAt(items, position);
  if (here !== undefined && here.position.slide + 1 < here.item.slides.length) {
    return { item: here.position.item, slide: here.position.slide + 1 };
  }
  const from = here?.position.item ?? clamp(position.item, items.length);
  for (let index = from + 1; index < items.length; index += 1) {
    const candidate = items[index];
    if (candidate !== undefined && candidate.slides.length > 0) return { item: index, slide: 0 };
  }
  return undefined;
}

/**
 * Which language this item is actually read in by a surface preferring `preferred`: that preference
 * when the item declares it, and the item's own first language when it does not. A preference belongs
 * to one surface, not to the service, and the item after this one is free to be a song that never
 * offered it — so the fallback is per item rather than a one-time resolution for the whole run.
 */
export function languageForItem(item: StageItem, preferred: string | undefined): string | undefined {
  return preferred !== undefined && item.languages.includes(preferred) ? preferred : item.languages[0];
}

const cueAt = ({ position, item }: StageStop, preferred: string | undefined): SurfaceCue => {
  const languageKey = languageForItem(item, preferred);
  const text = languageKey === undefined ? '' : (item.slides[position.slide]?.[languageKey] ?? '');
  return { position, title: item.title, languageKey, text };
};

/** What a non-Stage surface renders at one position, in the language it is reading. Carries no key:
 *  showing the key is Stage's, and a cue the other surfaces render is not the place to leak it. */
export function surfaceCue(
  items: readonly StageItem[],
  position: StagePosition,
  preferred: string | undefined,
): SurfaceCue | undefined {
  const here = stopAt(items, position);
  return here === undefined ? undefined : cueAt(here, preferred);
}

/** The same cue, plus the key — present only when the item carries one with something in it, and left
 *  off the object entirely otherwise, so a renderer has nothing to draw rather than something empty. */
export function stageCue(
  items: readonly StageItem[],
  position: StagePosition,
  preferred: string | undefined,
): StageCue | undefined {
  const here = stopAt(items, position);
  if (here === undefined) return undefined;
  const key = here.item.key?.trim();
  return { ...cueAt(here, preferred), ...(key === undefined || key === '' ? {} : { key }) };
}

/** What Stage shows: where it is, and what is coming — the latter resolved across the whole service
 *  rather than only within the current item, and each cue read in whatever language its own item
 *  offers Stage. */
export function stageLookAhead(
  items: readonly StageItem[],
  position: StagePosition,
  preferred: string | undefined,
): StageLookAhead {
  const next = nextStagePosition(items, position);
  return {
    current: stageCue(items, position, preferred),
    next: next === undefined ? undefined : stageCue(items, next, preferred),
  };
}

/**
 * Stage choosing its own content language. Writes `stage` and nothing else — Audience and Singer keep
 * whatever they were reading, which is the whole of what "Stage-local" means. A key is taken only when
 * it names a language the registry carries *and* one this item declares: the two rules `songs.ts` keeps
 * apart, for the same reason it keeps them apart. Anything else leaves the record exactly as it was,
 * because a Stage selection that cannot be honoured is a selection that changes no surface at all.
 */
export function selectStageLanguage(
  languages: SurfaceLanguages,
  item: StageItem | undefined,
  languageKey: string,
): SurfaceLanguages {
  if (item === undefined || !item.languages.includes(languageKey) || !isContentLanguageKey(languageKey)) {
    return languages;
  }
  return { ...languages, stage: languageKey };
}
