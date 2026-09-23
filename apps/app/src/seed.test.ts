import { describe, expect, it } from 'vitest';

import { instantiate } from '@holydeck/contracts/service-templates';
import { CONTENT_KINDS } from '@holydeck/contracts/layouts';

import { contentLanguagesOn } from './content-languages.js';
import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { SEED_ACTOR, seedContext, seedOn } from './seed.js';
import { serviceContext, servicesOn } from './services.js';
import { serviceTemplatesOn } from './service-templates.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLabelsOn } from './slide-labels.js';
import { slideLayoutsOn } from './slide-layouts.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ADMINISTRATOR = `account:${'A'.repeat(22)}`;

const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
};

const setup = (): { db: FakeDb; now: () => string } => ({ db: fakeDb(), now: clock() });

const stores = (db: FakeDb, now: () => string) => ({
  languages: contentLanguagesOn(db, { now }),
  labels: slideLabelsOn(db, { now }),
  layouts: slideLayoutsOn(db, { now }),
  templates: serviceTemplatesOn(db, { now, services: servicesOn(db, { now }) }),
  groups: slideGroupsOn(db, { now }),
});

/** A human Admin, not the seeding process — same permissions, a different actor, so an edit made
 *  under this context is one seed.ts must never overwrite on a second run. */
const adminContext = (correlationId: string): unknown =>
  requestContext({ actor: ADMINISTRATOR, permissions: [...seedContext('req-permission-scan0').permissions], correlationId });

const rowCounts = (db: FakeDb): Record<string, number> =>
  Object.fromEntries(Object.values(RECORDS).map((record) => [record.collection, (db.rows.get(record.collection) ?? []).length]));

describe('first-run seed data (SEED-01)', () => {
  it('leaves a fresh instance usable enough to build a whole service, with no catalogue authoring', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000001'));

    const { templates } = stores(db, now);
    const preview = await templates.preview(seedContext('req-read000000001'), outcome.serviceTemplates[0]!);
    expect(preview).toBeDefined();

    const instantiated = instantiate(preview!.body, []);
    expect(instantiated.ok).toBe(true);
    if (!instantiated.ok) return;
    expect(instantiated.items).toHaveLength(4);
    expect(instantiated.items.every((item) => item.kind === 'custom-slide' && item.content === undefined)).toBe(true);

    // Not just instantiated in the abstract: a real Service, created through the same store and the
    // same permission-checked context an Editor's own first Service goes through, built entirely from
    // what seeding left behind — no catalogue an Admin had to author first.
    const itemsById = new Map(instantiated.items.map((item) => [item.id, item]));
    const sections = preview!.body.sections.map((section) => ({
      id: section.id,
      name: section.name,
      items: section.entries.map((entry) => itemsById.get(entry.id)!),
    }));
    const services = servicesOn(db, { now });
    const created = await services.create(serviceContext(ADMINISTRATOR, 'req-service0000001'), {
      title: 'First Sunday',
      date: '2026-09-20',
      site: 'Main',
      sections,
    });
    expect(created.sections).toHaveLength(4);
    expect(created.sections.flatMap((s) => s.items).every((item) => item.content === undefined)).toBe(true);
  });

  it('seeds a content-language registry including Tamil and Romanized Tamil', async () => {
    const { db, now } = setup();
    await seedOn(db, { now }).run(seedContext('req-seed00000002'));

    const { languages } = stores(db, now);
    const catalogue = await languages.catalogue(seedContext('req-read000000002'));
    expect(catalogue.map((entry) => entry.stamp.id).sort()).toEqual(['ta', 'ta-Latn']);
  });

  it('seeds a slide-label catalogue with conflict-free shortcuts', async () => {
    const { db, now } = setup();
    await seedOn(db, { now }).run(seedContext('req-seed00000003'));

    const { labels } = stores(db, now);
    const catalogue = await labels.catalogue(seedContext('req-read000000003'));
    expect(catalogue).toHaveLength(8);
    const shortcuts = catalogue.map((entry) => entry.shortcut);
    expect(new Set(shortcuts).size).toBe(8);
  });

  it('seeds at least one Slide Layout per content kind', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000004'));

    const { layouts } = stores(db, now);
    for (const id of outcome.slideLayouts) {
      expect(await layouts.preview(seedContext('req-read000000004'), id)).toBeDefined();
    }
    const kinds = new Set<string>();
    for (const id of outcome.slideLayouts) {
      const preview = await layouts.preview(seedContext('req-read000000004'), id);
      for (const box of preview!.body.boxes) {
        if (box.kind === 'text' && box.binding.mode === 'keyed') kinds.add(box.binding.contentKind);
      }
    }
    for (const kind of CONTENT_KINDS) expect(kinds.has(kind)).toBe(true);
  });

  it('seeds one default Service Template with standard sections', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000005'));

    const { templates } = stores(db, now);
    expect(outcome.serviceTemplates).toHaveLength(1);
    const preview = await templates.preview(seedContext('req-read000000005'), outcome.serviceTemplates[0]!);
    expect(preview?.body.sections.map((entry) => entry.name)).toEqual(['Welcome', 'Worship', 'Message', 'Closing']);
  });

  it('seeds a default Standby empty screen, modelled as an empty slide group', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000006'));

    const { groups } = stores(db, now);
    expect(outcome.slideGroups).toHaveLength(1);
    const standby = await groups.current(seedContext('req-read000000006'), outcome.slideGroups[0]!);
    expect(standby?.body.slides).toEqual([]);
  });

  it('is idempotent: a second run creates no duplicate and overwrites no Admin edit', async () => {
    const { db, now } = setup();
    const seed = seedOn(db, { now });
    const first = await seed.run(seedContext('req-seed00000007'));
    const after1 = rowCounts(db);

    const { labels } = stores(db, now);
    const edited = await labels.edit(adminContext('req-admin0000007'), first.slideLabels[0]!, { name: 'Renamed by an Admin', shortcut: '1' });
    expect(edited?.name).toBe('Renamed by an Admin');

    const second = await seed.run(seedContext('req-seed00000008'));
    expect(second).toEqual(first);
    const after2 = rowCounts(db);
    expect(after2).toEqual({ ...after1, [RECORDS.slideLabels.collection]: after1[RECORDS.slideLabels.collection]! + 1 });

    const stillEdited = await labels.get(seedContext('req-read000000007'), first.slideLabels[0]!);
    expect(stillEdited?.name).toBe('Renamed by an Admin');
  });

  it('seeds records that are versioned, identifiable as seeded, editable and archivable', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000009'));
    const { languages, labels, layouts, templates, groups } = stores(db, now);
    const read = seedContext('req-read000000009');

    // content language: seeded, editable, archivable
    const language = await languages.get(read, outcome.contentLanguages[0]!);
    expect(language?.stamp.createdBy).toBe(SEED_ACTOR);
    const editedLanguage = await languages.edit(adminContext('req-admin0000009a'), outcome.contentLanguages[0]!, {
      displayName: 'Edited',
      script: language!.script,
      fallbackFont: language!.fallbackFont,
    });
    expect(editedLanguage?.displayName).toBe('Edited');
    expect((await languages.archive(adminContext('req-admin0000009b'), outcome.contentLanguages[0]!))?.stamp.archivedAt).toBeDefined();

    // slide label: seeded, editable, archivable
    const label = await labels.get(read, outcome.slideLabels[0]!);
    expect(label?.stamp.createdBy).toBe(SEED_ACTOR);
    const editedLabel = await labels.edit(adminContext('req-admin0000009c'), outcome.slideLabels[0]!, { name: 'Edited', shortcut: label!.shortcut });
    expect(editedLabel?.name).toBe('Edited');
    expect((await labels.archive(adminContext('req-admin0000009d'), outcome.slideLabels[0]!))?.stamp.archivedAt).toBeDefined();

    // slide layout: seeded, versioned, editable, archivable
    const layout = await layouts.preview(read, outcome.slideLayouts[0]!);
    expect(layout?.stamp.createdBy).toBe(SEED_ACTOR);
    expect(layout?.revision).toBe(1);
    const versioned = await layouts.version(adminContext('req-admin0000009e'), outcome.slideLayouts[0]!, layout!.body);
    expect(versioned).toBeDefined();
    expect((await layouts.archive(adminContext('req-admin0000009f'), outcome.slideLayouts[0]!))?.stamp.archivedAt).toBeDefined();

    // service template: seeded, versioned, editable and archivable, exactly like a Slide Layout.
    const template = await templates.preview(read, outcome.serviceTemplates[0]!);
    expect(template?.stamp.createdBy).toBe(SEED_ACTOR);
    expect(template?.revision).toBe(1);
    const templateVersioned = await templates.version(adminContext('req-admin0000009e2'), outcome.serviceTemplates[0]!, template!.body);
    expect(templateVersioned).toBeDefined();
    expect((await templates.archive(adminContext('req-admin0000009e3'), outcome.serviceTemplates[0]!))?.stamp.archivedAt).toBeDefined();

    // slide group: seeded and editable, but this store has no archive/unarchive — its offer/withdraw
    // verb is enable/disable (disclosed friction), exercised here instead.
    const group = await groups.current(read, outcome.slideGroups[0]!);
    expect(group?.stamp.createdBy).toBe(SEED_ACTOR);
    const editedGroup = await groups.edit(adminContext('req-admin0000009g'), outcome.slideGroups[0]!, group!.body);
    expect(editedGroup).toBeDefined();
    expect((await groups.disable(adminContext('req-admin0000009h'), outcome.slideGroups[0]!))?.body.enabled).toBe(false);
    expect((await groups.enable(adminContext('req-admin0000009i'), outcome.slideGroups[0]!))?.body.enabled).toBe(true);
  });

  it('carries no Bible text and no lyrics', async () => {
    const { db, now } = setup();
    const outcome = await seedOn(db, { now }).run(seedContext('req-seed00000010'));
    const { labels, layouts, templates, groups } = stores(db, now);
    const read = seedContext('req-read000000010');

    // Every seeded free-text field, swept in one place: this is a legally-sensitive requirement
    // (T11's no-bundled-licensed-content decision), so short and structural is checked directly
    // rather than merely inferred from how boxes are bound.
    const freeText: string[] = [];

    for (const id of outcome.slideLayouts) {
      const preview = await layouts.preview(read, id);
      freeText.push(preview!.name);
      for (const box of preview!.body.boxes) {
        if (box.kind === 'text') expect(box.binding.mode).toBe('keyed');
        if (box.kind === 'media') expect(box.placeholder).toBeUndefined();
      }
    }

    for (const id of outcome.slideLabels) {
      const label = await labels.get(read, id);
      freeText.push(label!.name);
    }

    for (const id of outcome.serviceTemplates) {
      const preview = await templates.preview(read, id);
      freeText.push(preview!.name);
      for (const section of preview!.body.sections) {
        freeText.push(section.name);
        for (const entry of section.entries) {
          if (entry.slot === 'fixed') {
            freeText.push(entry.title);
            expect(entry.content).toBeUndefined();
          }
        }
      }
    }

    for (const id of outcome.slideGroups) {
      const group = await groups.current(read, id);
      expect(group?.body.slides).toEqual([]);
      freeText.push(group!.title);
    }

    expect(freeText.length).toBeGreaterThan(0);
    for (const text of freeText) {
      expect(text.length).toBeLessThanOrEqual(40);
      expect(text).not.toContain('\n');
    }
  });
});
