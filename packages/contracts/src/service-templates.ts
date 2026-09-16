// A Service Template's own domain shape (spec TMPL-04): fixed and typed-slot entries an Admin defines,
// and the two pure functions that connect it to the rest of the domain — instantiating it into the items
// of a new service, and converting an existing service into one, without ever touching the source.
//
// Scope is exactly the plan's three tests-first bullets: entries are defined and instantiated; a service
// converts into a template without changing the service it came from; the schema cannot conflate this with
// a Slide Layout's box geometry. TMPL-04's fuller text — comparing a service against the template it was
// instantiated from, and pushing selected changes into a new template revision — is not built here. No ADR
// exists for a Service Template yet, `@holydeck/contracts/entities`'s closed `ENTITY_KINDS` registry does
// not carry one (a kind is added there once a requirement says what archiving it does, the same reason
// sermons and Service Templates were left out of it earlier), and nothing in this codebase yet consumes a
// drift comparison. Building it now would be a guess at a shape nothing has asked for; see progress.md's
// `## T41` for the ruling this scoping follows.
//
// Every produced `ServiceItem.id` equals the entry it came from, on both paths. That is deliberate: it is
// the correlation key a future drift comparison needs to match a service's item back to the template entry
// it was instantiated from, wired in now because it costs nothing extra, without building the comparison.

import { FIELD_CODES, type ParseFn, type Parsed, parseObject } from './problems.js';
import { ITEM_KINDS, parseRevisionRef } from './services.js';

import type { ItemKind, RevisionRef, Service, ServiceItem } from './services.js';

export const SLOT_KINDS = ['fixed', 'typed'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** The one kind of item that carries its own slides instead of referencing reusable content. */
const AUTHORED_IN_PLACE: ItemKind = 'custom-slide';

export type FixedEntry = {
  readonly id: string;
  readonly slot: 'fixed';
  readonly itemKind: ItemKind;
  readonly title: string;
  readonly content: RevisionRef | undefined;
};

export type TypedEntry = {
  readonly id: string;
  readonly slot: 'typed';
  readonly itemKind: ItemKind;
  readonly required: boolean;
};

export type ServiceTemplateEntry = FixedEntry | TypedEntry;

export type ServiceTemplateSection = {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly ServiceTemplateEntry[];
};

export type ServiceTemplateBody = {
  readonly sections: readonly ServiceTemplateSection[];
};

export type ServiceTemplateDraft = {
  readonly name: string;
  readonly body: ServiceTemplateBody;
};

const entryParser = (seenEntries: Set<string>): ParseFn<ServiceTemplateEntry> => (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    if (id !== '' && seenEntries.has(id)) {
      reader.reject('id', FIELD_CODES.notAllowed, 'must not repeat an entry already in this Service Template');
    }
    seenEntries.add(id);
    const slot = reader.choice('slot', SLOT_KINDS);
    const itemKind = reader.choice('itemKind', ITEM_KINDS);
    if (slot === 'typed') {
      reader.absent('title', FIELD_CODES.notAllowed, 'must not be set on a typed entry');
      reader.absent('content', FIELD_CODES.notAllowed, 'must not be set on a typed entry');
      return { id, slot, itemKind, required: reader.flag('required') };
    }
    reader.absent('required', FIELD_CODES.notAllowed, 'must not be set on a fixed entry');
    const title = reader.text('title');
    if (itemKind === AUTHORED_IN_PLACE) {
      reader.absent('content', FIELD_CODES.notAllowed, 'must not be pinned by a custom slide');
      return { id, slot, itemKind, title, content: undefined };
    }
    return { id, slot, itemKind, title, content: reader.parsed('content', parseRevisionRef, undefined) };
  });

const sectionParser = (seenSections: Set<string>, seenEntries: Set<string>): ParseFn<ServiceTemplateSection> =>
  (value, path) =>
    parseObject(value, path, (reader) => {
      const id = reader.text('id');
      if (id !== '' && seenSections.has(id)) {
        reader.reject('id', FIELD_CODES.notAllowed, 'must not repeat a section already in this Service Template');
      }
      seenSections.add(id);
      return { id, name: reader.text('name'), entries: reader.parsedList('entries', entryParser(seenEntries)) };
    });

export function parseServiceTemplateBody(value: unknown): Parsed<ServiceTemplateBody> {
  return parseObject(value, 'serviceTemplate', (reader) => ({
    sections: reader.parsedList('sections', sectionParser(new Set(), new Set())),
  }));
}

export function parseServiceTemplateDraft(value: unknown): Parsed<ServiceTemplateDraft> {
  return parseObject(value, 'serviceTemplate', (reader) => {
    const name = reader.text('name');
    const sections = reader.parsedList('sections', sectionParser(new Set(), new Set()));
    return { name, body: { sections } };
  });
}

export type EntryFill = {
  readonly entryId: string;
  readonly title: string;
  readonly content: RevisionRef | undefined;
};

export type InstantiationError = {
  readonly entryId: string;
  readonly kind: 'unfilled-required-slot' | 'content-not-allowed';
  readonly message: string;
};

export type InstantiationOutcome =
  | { readonly ok: true; readonly items: readonly ServiceItem[] }
  | { readonly ok: false; readonly errors: readonly InstantiationError[] };

/**
 * Every fixed entry becomes an item unconditionally; every typed entry becomes one only when a fill for
 * it was given. A required typed entry with none is refused by name, and every such slot is named at once
 * rather than the first: the Editor instantiating a Service Template needs the whole list to fill it once.
 */
export function instantiate(body: ServiceTemplateBody, fills: readonly EntryFill[]): InstantiationOutcome {
  const fillById = new Map(fills.map((fill) => [fill.entryId, fill]));
  const errors: InstantiationError[] = [];
  const items: ServiceItem[] = [];
  for (const section of body.sections) {
    for (const entry of section.entries) {
      if (entry.slot === 'fixed') {
        items.push({ id: entry.id, kind: entry.itemKind, title: entry.title, content: entry.content });
        continue;
      }
      const fill = fillById.get(entry.id);
      if (fill === undefined) {
        if (entry.required) {
          errors.push({
            entryId: entry.id,
            kind: 'unfilled-required-slot',
            message: `${entry.id} is a required slot and was not filled`,
          });
        }
        continue;
      }
      if (entry.itemKind === AUTHORED_IN_PLACE && fill.content !== undefined) {
        errors.push({
          entryId: entry.id,
          kind: 'content-not-allowed',
          message: `${entry.id} is a custom slide and must not be filled with pinned content`,
        });
        continue;
      }
      items.push({ id: entry.id, kind: entry.itemKind, title: fill.title, content: fill.content });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, items };
}

/** Converts a service into a Service Template body, one fixed entry per item. The service is only read. */
export function templateFromService(service: Service): ServiceTemplateBody {
  return {
    sections: service.sections.map((section) => ({
      id: section.id,
      name: section.name,
      entries: section.items.map(
        (item): FixedEntry => ({
          id: item.id,
          slot: 'fixed',
          itemKind: item.kind,
          title: item.title,
          content: item.content,
        }),
      ),
    })),
  };
}
