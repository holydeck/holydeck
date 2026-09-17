// The global slide-label catalogue (spec LABL-01): "Admin can manage global slide labels and
// conflict-free live keyboard shortcuts; Editor can assign labels to slides." Two rules live here and
// nowhere else, because both of them have to hold for the catalogue as a whole rather than for one
// record at a time: no two labels an Editor can still choose may share a name or a live shortcut, and
// a label an Editor did not choose from this catalogue is not a label at all.
//
// Each label is its own durable entity — `entities.ts` carries the `slideLabel` kind and the policy
// that archiving one hides it while every slide already labelled with it keeps reading. It is
// deliberately not a `LIBRARY_KINDS` entry: the library is reusable multi-instance *content* people
// author, while this is a small set of individually stamped, individually archivable administrative
// records, which is the shape SEED-01's "fully editable and archivable" seeded entries need.
//
// `slide-groups.ts`'s `Slide.label` is still free text and this file does not change it. What this
// file adds is the check that turns a typed label into a chosen one — `readAssignedLabel` — for
// whichever later task wires a real slide-editing surface to it. Nothing here throws: a caller of a
// catalogue rule gets a `Parsed` or a list of conflicts, for the reason `problems.ts` states.

import { FIELD_CODES, type FieldReader, type Parsed, type ParseFn, parseObject } from './problems.js';

import type { EntityKind } from './entities.js';

/** The kind each catalogue entry is stamped as, named once so a store never types the word again. */
export const SLIDE_LABEL_KIND = 'slideLabel' satisfies EntityKind;

/**
 * Every key a live shortcut may be, and the whole space "conflict-free across the whole catalogue" is
 * asserted over. The number row, in the order it sits in under a hand, and nothing else:
 *
 *   - It is the one part of a keyboard that does not move between layouts. QWERTY, QWERTZ, AZERTY and
 *     Dvorak disagree about where nearly every letter is, so a letter shortcut an Admin assigns on one
 *     machine is a different physical key on the operator's — and a live shortcut nobody can find is
 *     worse than none.
 *   - It collides with nothing a live controller already spends: transport is the space bar, the arrow
 *     keys and Escape, and blanking is conventionally a letter. Choosing letters here would mean
 *     inventing a reserved-letter list no requirement has decided yet, which is the kind of undecided
 *     assumption `entities.ts` exists to refuse.
 *   - Ten is a number an operator holds in their head and finds without looking down. A single-key
 *     space large enough to never run out would already be too large to use live.
 *
 * `shortcut` is therefore optional on a label (see `SlideLabelDraft`): ten keys bound the labels that
 * can be *jumped to*, not the labels that can exist.
 */
export const SHORTCUT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

export type ShortcutKey = (typeof SHORTCUT_KEYS)[number];

/** What an Admin hands in to create or re-save one label: what it is called, and what jumps to it. */
export interface SlideLabelDraft {
  readonly name: string;
  /** Absent means this label is assignable but not reachable by a single keypress. */
  readonly shortcut?: ShortcutKey;
}

/** One entry of the catalogue as the rules below read it: a draft that has been stamped with an id. */
export interface SlideLabelEntry extends SlideLabelDraft {
  readonly id: string;
}

/**
 * A field the payload never offered is absent, which is what "this label has no shortcut" is written
 * as. A field it did offer is graded against the closed list, so an ad-hoc key is refused exactly the
 * way an ad-hoc kind is.
 */
const readShortcut = (reader: FieldReader): ShortcutKey | undefined =>
  reader.names.includes('shortcut') ? reader.choice('shortcut', SHORTCUT_KEYS) : undefined;

export const parseSlideLabelDraft: ParseFn<SlideLabelDraft> = (value, path) =>
  parseObject(value, path, (reader) => {
    const name = reader.text('name');
    const shortcut = readShortcut(reader);
    return { name, ...(shortcut === undefined ? {} : { shortcut }) };
  });

/** Which of the two catalogue-wide rules was broken. Both block saving; neither is a bad payload. */
export const CONFLICT_FIELDS = ['name', 'shortcut'] as const;

export type ConflictField = (typeof CONFLICT_FIELDS)[number];

/** One collision, named rather than described: what was claimed, and which label already holds it. */
export interface CatalogueConflict {
  readonly field: ConflictField;
  /** The name or the shortcut key that is already taken. */
  readonly claimed: string;
  /** The identifier of the live label holding it, so a caller can say which one to change. */
  readonly heldBy: string;
}

/** How one conflict is said out loud, once, so every layer that reports one says it the same way. */
export const readableConflict = (conflict: CatalogueConflict): string =>
  `the ${conflict.field} ${conflict.claimed} is already held by ${conflict.heldBy}`;

/**
 * Every rule a claim breaks against the labels an Editor can still choose. A label never conflicts
 * with itself, so re-saving one under its own name and its own shortcut is not a collision — which is
 * what lets an Admin rename a label without first surrendering its key.
 *
 * Archived labels are not read: archiving hides a label and frees the key it held, which is the whole
 * behavioural difference between `archive: 'hidden'` and `archive: 'disabled'`.
 */
export function conflictsWith(
  live: readonly SlideLabelEntry[],
  claim: SlideLabelEntry,
): readonly CatalogueConflict[] {
  const found: CatalogueConflict[] = [];
  for (const entry of live) {
    if (entry.id === claim.id) continue;
    if (entry.name === claim.name) found.push({ field: 'name', claimed: claim.name, heldBy: entry.id });
    if (claim.shortcut !== undefined && entry.shortcut === claim.shortcut) {
      found.push({ field: 'shortcut', claimed: claim.shortcut, heldBy: entry.id });
    }
  }
  return found;
}

/**
 * Every collision the catalogue holds as it stands, each reported against the earlier of the two
 * entries that share something. Empty is the property LABL-01 asks for; a store that grades every
 * write with `conflictsWith` keeps it empty, and this is how that is checked rather than assumed.
 */
export function conflictsIn(live: readonly SlideLabelEntry[]): readonly CatalogueConflict[] {
  const found: CatalogueConflict[] = [];
  for (const [at, entry] of live.entries()) found.push(...conflictsWith(live.slice(0, at), entry));
  return found;
}

/** The label each shortcut key currently jumps to, for the accessible shortcut reference to list. */
export function shortcutsOf(live: readonly SlideLabelEntry[]): ReadonlyMap<ShortcutKey, SlideLabelEntry> {
  const bound = new Map<ShortcutKey, SlideLabelEntry>();
  for (const entry of live) {
    if (entry.shortcut !== undefined && !bound.has(entry.shortcut)) bound.set(entry.shortcut, entry);
  }
  return bound;
}

/**
 * The label an Editor assigned, or why it is not one. Labels are assigned from the global catalogue
 * only: a name nobody put in the catalogue is refused rather than quietly created, so the catalogue
 * stays the one place a label is managed from. An archived label is not in `live` and is therefore
 * not assignable either — an existing slide that already carries its name keeps reading, because
 * nothing re-grades a slide that was labelled while the label was still offered.
 */
export function readAssignedLabel(
  live: readonly SlideLabelEntry[],
  value: unknown,
  path = 'label',
): Parsed<SlideLabelEntry> {
  if (typeof value !== 'string') {
    return { ok: false, problems: [{ path, code: FIELD_CODES.notText, message: 'must be text' }] };
  }
  const entry = live.find((candidate) => candidate.name === value);
  if (entry === undefined) {
    return {
      ok: false,
      problems: [
        { path, code: FIELD_CODES.notAllowed, message: 'must name a label of the global slide-label catalogue' },
      ],
    };
  }
  return { ok: true, value: entry };
}
