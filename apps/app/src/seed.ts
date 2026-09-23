// First-run seed data (spec SEED-01): the records that make a freshly initialized instance usable
// without an Admin hand-building a single catalogue first. This file adds no store, record, or
// migration of its own — it composes five already-shipped ones (`content-languages.ts`,
// `slide-labels.ts`, `slide-layouts.ts`, `service-templates.ts`, `slide-groups.ts`) and decides only
// which records those stores need to already hold, and that each is written exactly once.
//
// Idempotency, not an update verb, is what every seeded record leans on. Nothing here writes to the
// records layer directly: every seed goes through the same `create` an Admin's own first record
// would go through, so a seeded record is an ordinary one — versioned, and editable and archivable
// in exactly the ways a hand-created one of its kind already is. What makes re-running this safe is
// that every seeded record is checked for *before* it is created, under a well-known, deterministic
// identity chosen here rather than left to whichever `newId` a store would otherwise mint. A content
// language already has a stable identity of its own — its key — so it needs no help. The other four
// kinds mint an id internally, so this file supplies a fixed one, via an ephemeral store instance
// built with `newId` pinned to it, only at the moment of creating that one seed record — the same
// trick `library.ts`'s own header already anticipates for a caller that must know an id before a
// store agrees to mint one. A second run finds every one of those identities already stamped, calls
// no store's `create` a second time, and so reads back an Admin's own edit to a seeded record — its
// name, its shortcut, its boxes — exactly as the Admin left it, never as this file would restart it.
//
// Two boots racing this same check-then-create is the same shape `migrations.ts` already guards
// against for the ledger it claims — a unique identity refuses the loser's write. There, the loser
// is left refused, because a schema migration cannot half-apply. Here, the loser has lost nothing:
// the record it wanted to seed is, by the time it is refused, exactly what the winner just wrote. So
// `ensured` below catches only that one store's own conflict refusal, re-reads to confirm the record
// now exists, and moves on — a boot that raced another one still serves rather than crashing on a
// database that is in fact already correctly seeded.
//
// Nothing seeded here carries licensed content. A Slide Layout's Text box is bound by field name —
// `KeyedBinding.contentKind`/`contentKey`/`languageKey` — never by literal words, so no seed layout
// can carry a Bible verse or a lyric line by construction (see `@holydeck/contracts/layouts`'s own
// header); every text box seeded below is bound this way, never `'static'`. The one Media box seeded
// — the Standby Layout's backdrop — carries no placeholder text. The default Service Template's four
// sections are `custom-slide` entries with `content: undefined`, so instantiating it pins nothing.
// The default Standby slide group is an empty screen on purpose: `slides: []`.
//
// One seeded kind falls short of "editable and archivable" in a way disclosed here rather than
// papered over, because inventing an edit verb would be a guess at a shape no requirement has asked
// for (see `slide-groups.ts`'s own header for the same ruling made there first). `SlideGroupStore`
// has no `archive`/`unarchive`; a slide group's offer/withdraw verb is `enable`/`disable`, and the
// seeded Standby group is exercised through that instead.

import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';

import { CONTENT_LANGUAGE_PERMISSIONS, ContentLanguageError, contentLanguagesOn } from './content-languages.js';
import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS } from './library.js';
import { REVISION_PERMISSIONS } from './revisions.js';
import { SERVICE_TEMPLATE_PERMISSIONS, ServiceTemplateError, serviceTemplatesOn } from './service-templates.js';
import { servicesOn } from './services.js';
import { SLIDE_LABEL_PERMISSIONS, SlideLabelError, slideLabelsOn } from './slide-labels.js';
import { LAYOUT_PERMISSIONS, SlideLayoutError, slideLayoutsOn } from './slide-layouts.js';
import { SlideGroupError, slideGroupsOn } from './slide-groups.js';

import type { LayoutBox, SlideLayoutBody } from '@holydeck/contracts/layouts';
import type { ServiceTemplateBody, ServiceTemplateSection } from '@holydeck/contracts/service-templates';
import type { ShortcutKey } from '@holydeck/contracts/slide-labels';
import type { SlideGroupBody } from '@holydeck/contracts/slide-groups';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

/** Every seed is authored under this actor, so a seeded record is identifiable as one at a glance. */
export const SEED_ACTOR = 'system';

/** The one context seeding runs under: the union of every store it writes through, and nothing else. */
export function seedContext(correlationId: string): RequestContext {
  return requestContext({
    actor: SEED_ACTOR,
    permissions: [
      ...Object.values(CONTENT_LANGUAGE_PERMISSIONS),
      ...Object.values(SLIDE_LABEL_PERMISSIONS),
      ...Object.values(LAYOUT_PERMISSIONS),
      ...Object.values(SERVICE_TEMPLATE_PERMISSIONS),
      ...Object.values(LIBRARY_PERMISSIONS),
      ...Object.values(REVISION_PERMISSIONS),
    ],
    correlationId,
  });
}

// 'ta': spec §11.5 seeds Tamil as this instance's first content language, so a seeded box is bound
// to it by default rather than left to bind against a registry entry nothing has created yet.
const textBox = (id: string, contentKind: 'song' | 'sermon' | 'reading', contentKey: string): LayoutBox => ({
  id,
  kind: 'text',
  frame: { x: 0.1, y: 0.6, width: 0.8, height: 0.3 },
  importance: 'required',
  binding: { mode: 'keyed', contentKind, contentKey, languageKey: 'ta' },
  style: { fontFamily: 'sans-serif', fontWeight: 400, sizeRatio: 0.08, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
});

/** The Standby Layout's own id, named once because the seeded Standby group's default points at it. */
const STANDBY_LAYOUT_ID = 'seed-layout-standby';

const SEED_LAYOUTS: readonly { readonly id: string; readonly name: string; readonly body: SlideLayoutBody }[] = [
  { id: 'seed-layout-song', name: 'Song', body: { boxes: [textBox('lyric', 'song', 'lyricLine')] } },
  { id: 'seed-layout-sermon', name: 'Sermon', body: { boxes: [textBox('point', 'sermon', 'point')] } },
  { id: 'seed-layout-reading', name: 'Reading', body: { boxes: [textBox('verse', 'reading', 'verseText')] } },
  {
    id: STANDBY_LAYOUT_ID,
    name: 'Standby',
    body: {
      boxes: [
        { id: 'backdrop', kind: 'media', frame: { x: 0, y: 0, width: 1, height: 1 }, importance: 'decoration', style: { fit: 'cover', opacity: 1 } },
      ],
    },
  },
];

const SEED_LABELS: readonly { readonly id: string; readonly name: string; readonly shortcut: ShortcutKey }[] = [
  { id: 'seed-label-verse', name: 'Verse', shortcut: '1' },
  { id: 'seed-label-chorus', name: 'Chorus', shortcut: '2' },
  { id: 'seed-label-bridge', name: 'Bridge', shortcut: '3' },
  { id: 'seed-label-pre-chorus', name: 'Pre-Chorus', shortcut: '4' },
  { id: 'seed-label-intro', name: 'Intro', shortcut: '5' },
  { id: 'seed-label-outro', name: 'Outro', shortcut: '6' },
  { id: 'seed-label-tag', name: 'Tag', shortcut: '7' },
  { id: 'seed-label-title', name: 'Title', shortcut: '8' },
];

const section = (id: string, name: string): ServiceTemplateSection => ({
  id,
  name,
  entries: [{ id: `${id}-slide`, slot: 'fixed', itemKind: 'custom-slide', title: name, content: undefined }],
});

const SEED_TEMPLATES: readonly { readonly id: string; readonly name: string; readonly body: ServiceTemplateBody }[] = [
  {
    id: 'seed-template-default',
    name: 'Default Service',
    body: { sections: [section('welcome', 'Welcome'), section('worship', 'Worship'), section('message', 'Message'), section('closing', 'Closing')] },
  },
];

const SEED_GROUPS: readonly { readonly id: string; readonly title: string; readonly body: SlideGroupBody }[] = [
  { id: 'seed-group-standby', title: 'Standby', body: { mode: 'custom', enabled: true, slideLayoutId: STANDBY_LAYOUT_ID, slides: [] } },
];

export interface SeedOptions {
  /** Injected, so every instant a seed writes comes from one clock and a test does not wait. */
  readonly now: () => string;
}

export interface SeedOutcome {
  readonly contentLanguages: readonly string[];
  readonly slideLabels: readonly string[];
  readonly slideLayouts: readonly string[];
  readonly serviceTemplates: readonly string[];
  readonly slideGroups: readonly string[];
}

export interface Seed {
  /**
   * Seeds whichever of these records a fresh instance does not already hold, under the well-known
   * id each is checked for by, and returns every one of those ids regardless of whether this call
   * is the one that created it — so a second run's outcome names the same records as the first.
   * Safe to call twice, and safe to call from two boots racing each other (see the header above).
   */
  run(context: unknown): Promise<SeedOutcome>;
}

/**
 * Writes one seed record only if `read` does not already find it, the way every store's own
 * `create` is checked against before this file ever calls it. If a concurrent boot won the race —
 * `write` throws the conflict `isLostRace` names for this store — this run has lost nothing: the
 * record it wanted is, by construction, exactly what the winner just wrote, so a re-read confirming
 * it now exists is enough to move on rather than fail this boot over a database that is in fact
 * already correctly seeded. Any other failure, including a conflict the re-read cannot confirm, is
 * still raised: it is not the race this file knows how to shrug off.
 */
async function ensured(
  read: () => Promise<unknown>,
  write: () => Promise<unknown>,
  isLostRace: (error: unknown) => boolean,
): Promise<void> {
  if ((await read()) !== undefined) return;
  try {
    await write();
  } catch (error) {
    if (isLostRace(error) && (await read()) !== undefined) return;
    throw error;
  }
}

export function seedOn(db: RepositoryDb, options: SeedOptions): Seed {
  const languages = contentLanguagesOn(db, { now: options.now });
  const labels = slideLabelsOn(db, { now: options.now });
  const layouts = slideLayoutsOn(db, { now: options.now });
  const services = servicesOn(db, { now: options.now });
  const templates = serviceTemplatesOn(db, { now: options.now, services });
  const groups = slideGroupsOn(db, { now: options.now });

  return {
    async run(context) {
      const seededLanguages: string[] = [];
      for (const language of CONTENT_LANGUAGES) {
        await ensured(
          () => languages.get(context, language.key),
          () =>
            languages.create(context, language.key, {
              displayName: language.displayName,
              script: language.script,
              fallbackFont: language.fallbackFont,
            }),
          (error) => error instanceof ContentLanguageError && error.kind === 'conflict',
        );
        seededLanguages.push(language.key);
      }

      const seededLabels: string[] = [];
      for (const label of SEED_LABELS) {
        await ensured(
          () => labels.get(context, label.id),
          () =>
            slideLabelsOn(db, { now: options.now, newId: () => label.id }).create(context, {
              name: label.name,
              shortcut: label.shortcut,
            }),
          (error) => error instanceof SlideLabelError && error.kind === 'conflict',
        );
        seededLabels.push(label.id);
      }

      const seededLayouts: string[] = [];
      for (const layout of SEED_LAYOUTS) {
        await ensured(
          () => layouts.preview(context, layout.id),
          () =>
            slideLayoutsOn(db, { now: options.now, newId: () => layout.id }).create(context, {
              name: layout.name,
              body: layout.body,
            }),
          (error) => error instanceof SlideLayoutError && error.kind === 'conflict',
        );
        seededLayouts.push(layout.id);
      }

      const seededTemplates: string[] = [];
      for (const template of SEED_TEMPLATES) {
        await ensured(
          () => templates.preview(context, template.id),
          () =>
            serviceTemplatesOn(db, { now: options.now, newId: () => template.id, services }).create(context, {
              name: template.name,
              body: template.body,
            }),
          (error) => error instanceof ServiceTemplateError && error.kind === 'conflict',
        );
        seededTemplates.push(template.id);
      }

      const seededGroups: string[] = [];
      for (const group of SEED_GROUPS) {
        await ensured(
          () => groups.current(context, group.id),
          () =>
            slideGroupsOn(db, { now: options.now, newId: () => group.id }).create(
              context,
              'slideGroup',
              group.title,
              group.body,
            ),
          (error) => error instanceof SlideGroupError && error.kind === 'conflict',
        );
        seededGroups.push(group.id);
      }

      return {
        contentLanguages: seededLanguages,
        slideLabels: seededLabels,
        slideLayouts: seededLayouts,
        serviceTemplates: seededTemplates,
        slideGroups: seededGroups,
      };
    },
  };
}
