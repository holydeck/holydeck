import { randomBytes } from 'node:crypto';

import {
  EntityError,
  archivedStamp,
  createdStamp,
  parseEntityStamp,
  restoredStamp,
  touchedStamp,
} from '@holydeck/contracts/entities';
import {
  SERVICE_STATE_LABELS,
  isCalendarDay,
  isCanonicalTransition,
  parseService,
  parseServiceDraft,
} from '@holydeck/contracts/services';

import { auditOn } from './audit.js';
import { contextProblems, requestContext } from './context.js';
import { LIBRARY_RECORD, libraryOn } from './library.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { REVISION_RECORD, revisionsOn } from './revisions.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { RevisionRef, ServiceDraft, ServiceItem, ServiceOutput, ServiceSection, ServiceState } from '@holydeck/contracts/services';

import type { AuditAction } from './audit.js';
import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

export const SERVICE_RECORD = 'services';
export const SERVICE_PERMISSIONS = permissionsFor(SERVICE_RECORD);
export const subjectFor = (id: string): string => `service:${id}`;

export interface ServiceIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly ServiceIndex[] = [
  { name: 'service_stamp', keys: { serviceId: 1, sequence: -1 }, options: { unique: true } },
];

export const SERVICE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type ServiceRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

export class ServiceError extends Error {
  readonly kind: ServiceRefusal;

  constructor(kind: ServiceRefusal, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.kind = kind;
  }
}

export function serviceContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(SERVICE_PERMISSIONS),
      permissionsFor('auditEvents').append,
      permissionsFor(LIBRARY_RECORD).read,
      permissionsFor(REVISION_RECORD).read,
    ],
    correlationId,
  });
}

export interface ServiceRecord {
  readonly stamp: EntityStamp;
  readonly title: string;
  readonly date: string;
  readonly site: string;
  readonly state: ServiceState;
  readonly sections: readonly ServiceSection[];
  readonly output?: ServiceOutput;
}

export type ItemContentDrift = {
  readonly itemId: string;
  readonly contentId: string;
  readonly pinnedRevision: number;
  readonly latestRevision: number;
  readonly drifted: boolean;
};

export interface ServiceStore {
  create(context: unknown, draft: ServiceDraft): Promise<ServiceRecord>;
  /** Every Service's standing record. Read-only, so — like `current` below — it needs no audit
   *  permission: nothing here writes. */
  list(context: unknown): Promise<readonly ServiceRecord[]>;
  /** A new Service with the same title, date, site, and sections/items — items keep their own
   *  RevisionRef verbatim (same id/revision/hash), never copying the content it points to. Fresh
   *  id, fresh entity stamp, state starts at 'upcoming' regardless of the source's state. */
  duplicate(context: unknown, id: string): Promise<ServiceRecord | undefined>;
  /** Changes the date only. Never touches state. */
  schedule(context: unknown, id: string, date: string): Promise<ServiceRecord | undefined>;
  transition(context: unknown, id: string, toState: ServiceState): Promise<ServiceRecord | undefined>;
  /** Changes sections/items. Never touches title, date, site, or state. */
  edit(context: unknown, id: string, sections: readonly ServiceSection[]): Promise<ServiceRecord | undefined>;
  /** Changes the optional output profile before a Service is presented. */
  setOutput(context: unknown, id: string, output: ServiceOutput): Promise<ServiceRecord | undefined>;
  /** Appends one new item, whole (including its own id), to a named section. */
  addItem(context: unknown, id: string, sectionId: string, item: ServiceItem): Promise<ServiceRecord | undefined>;
  /** Drops one item from wherever it lives in this Service. Never touches the global content its
   *  RevisionRef names — that content is untouched by construction, since this only ever rewrites
   *  the `services` record. */
  removeItem(context: unknown, id: string, itemId: string): Promise<ServiceRecord | undefined>;
  enableItem(context: unknown, id: string, itemId: string): Promise<ServiceRecord | undefined>;
  /** A disabled item stays in the Service; only presentation order (a later task) skips it. */
  disableItem(context: unknown, id: string, itemId: string): Promise<ServiceRecord | undefined>;
  /** A fresh id and a copy placed right after the original, in the same section. Its RevisionRef, if
   *  any, is copied verbatim — never the content it points to. */
  duplicateItem(context: unknown, id: string, itemId: string): Promise<ServiceRecord | undefined>;
  /** Reorders one section's items. `itemIds` must name exactly that section's current items, once each. */
  reorderItems(
    context: unknown,
    id: string,
    sectionId: string,
    itemIds: readonly string[],
  ): Promise<ServiceRecord | undefined>;
  /** Moves one item's content reference onto a later revision of the same content, chosen by ordinal.
   *  Refuses an item with no content reference (every 'custom-slide' item, and any item nothing has
   *  ever pinned), an id that names no library item, or an ordinal that names no revision of it.
   *  Recorded with actor and time, like every other item mutator (ADR 0005: opt-in only). */
  reviseItem(context: unknown, id: string, itemId: string, revision: number): Promise<ServiceRecord | undefined>;
  /** Every item's pinned revision against the latest one its content currently has. Read-only: nothing
   *  here, or anywhere else in this store, ever moves an item onto a newer revision by itself — that is
   *  `reviseItem`'s job alone (ADR 0005). */
  contentDrift(context: unknown, id: string): Promise<readonly ItemContentDrift[] | undefined>;
  archive(context: unknown, id: string): Promise<ServiceRecord | undefined>;
  unarchive(context: unknown, id: string): Promise<ServiceRecord | undefined>;
  current(context: unknown, id: string): Promise<ServiceRecord | undefined>;
}

export interface ServiceOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

const SERVICE_ID_BYTES = 16;
const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

interface ItemAddress {
  readonly sectionIndex: number;
  readonly itemIndex: number;
}

const locateItem = (sections: readonly ServiceSection[], itemId: string): ItemAddress => {
  for (const [sectionIndex, section] of sections.entries()) {
    const itemIndex = section.items.findIndex((item) => item.id === itemId);
    if (itemIndex !== -1) return { sectionIndex, itemIndex };
  }
  throw new ServiceError('schema', `${itemId} does not name an item in this Service`);
};

const locateSection = (sections: readonly ServiceSection[], sectionId: string): number => {
  const sectionIndex = sections.findIndex((section) => section.id === sectionId);
  if (sectionIndex === -1) throw new ServiceError('schema', `${sectionId} does not name a section in this Service`);
  return sectionIndex;
};

const withAddedItem = (
  sections: readonly ServiceSection[],
  sectionId: string,
  item: ServiceItem,
): readonly ServiceSection[] => {
  const sectionIndex = locateSection(sections, sectionId);
  return sections.map((section, index) =>
    index === sectionIndex ? { ...section, items: [...section.items, item] } : section,
  );
};

const withoutItem = (sections: readonly ServiceSection[], itemId: string): readonly ServiceSection[] => {
  locateItem(sections, itemId);
  return sections.map((section) => ({ ...section, items: section.items.filter((item) => item.id !== itemId) }));
};

const withChangedItem = (
  sections: readonly ServiceSection[],
  itemId: string,
  change: (item: ServiceItem) => ServiceItem,
): readonly ServiceSection[] => {
  const { sectionIndex, itemIndex } = locateItem(sections, itemId);
  return sections.map((section, index) => {
    if (index !== sectionIndex) return section;
    return { ...section, items: section.items.map((item, i) => (i === itemIndex ? change(item) : item)) };
  });
};

const withDuplicatedItem = (
  sections: readonly ServiceSection[],
  itemId: string,
  freshId: string,
): readonly ServiceSection[] => {
  const { sectionIndex, itemIndex } = locateItem(sections, itemId);
  return sections.map((section, index) => {
    if (index !== sectionIndex) return section;
    const items = [...section.items];
    items.splice(itemIndex + 1, 0, { ...items[itemIndex]!, id: freshId });
    return { ...section, items };
  });
};

const withReorderedItems = (
  sections: readonly ServiceSection[],
  sectionId: string,
  itemIds: readonly string[],
): readonly ServiceSection[] => {
  const sectionIndex = locateSection(sections, sectionId);
  const section = sections[sectionIndex]!;
  const byId = new Map(section.items.map((item) => [item.id, item] as const));
  const matches = itemIds.length === section.items.length && itemIds.every((id) => byId.has(id));
  if (!matches) {
    throw new ServiceError('schema', `reorder must name exactly ${sectionId}'s current items, once each`);
  }
  const items = itemIds.map((id) => byId.get(id)!);
  return sections.map((current, index) => (index === sectionIndex ? { ...current, items } : current));
};

function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new ServiceError('state', error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new ServiceError('conflict', `${error.message}, so another writer stamped this Service first`);
  }
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

const requireAuditPermission = (context: unknown): void => {
  const problems = contextProblems(context);
  if (problems.length > 0) throw new RepositoryError('context', `auditEvents: ${problems.join('; ')}`);
  const granted = (context as RequestContext).permissions;
  const permission = permissionsFor('auditEvents').append;
  if (!granted.includes(permission)) {
    throw new RepositoryError('permission', `auditEvents: the actor may not append, which needs ${permission}`);
  }
};

function readDraft(draft: ServiceDraft): ServiceDraft {
  const parsed = parseServiceDraft(draft);
  if (!parsed.ok) throw new ServiceError('schema', `this is not a Service: ${problems(parsed.problems)}`);
  return parsed.value;
}

interface StampRow extends ServiceRecord {
  readonly sequence: number;
}

type ServiceFields = ServiceDraft & { readonly state: ServiceState; readonly output?: ServiceOutput };

export function servicesOn(db: RepositoryDb, options: ServiceOptions): ServiceStore {
  const records = repositoriesOn(db)[SERVICE_RECORD];
  const trail = auditOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(SERVICE_ID_BYTES).toString('base64url'));
  const library = libraryOn(db, { now: options.now });
  const revisions = revisionsOn(db, { now: options.now });

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (id: string, found: Record<string, unknown>): StampRow => {
    const sequence = found['sequence'];
    if (typeof sequence !== 'number') {
      throw new ServiceError('corrupt', `${id} is stamped with an ordinal this code cannot read`);
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new ServiceError('corrupt', `${id} holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    const service = parseService({ ...found, id });
    if (!service.ok) {
      throw new ServiceError('corrupt', `${id} holds a Service this code cannot read: ${problems(service.problems)}`);
    }
    const { title, date, site, state, sections, output } = service.value;
    return {
      stamp: parsed.value, title, date, site, state, sections,
      ...(output === undefined ? {} : { output }), sequence,
    };
  };

  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { serviceId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(id, found);
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    fields: ServiceFields,
    sequence: number,
  ): Promise<ServiceRecord> => {
    const { title, date, site, state, sections, output } = fields;
    const record = { stamp, title, date, site, state, sections, ...(output === undefined ? {} : { output }) };
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      serviceId: stamp.id,
      sequence,
      at: stamp.updatedAt,
      ...record,
      ...author(context),
    });
    return record;
  };

  const audited = async (
    context: unknown,
    record: ServiceRecord,
    action: AuditAction,
    detail: string,
  ): Promise<ServiceRecord> => {
    await trail.record(context, { action, subject: subjectFor(record.stamp.id), outcome: 'allowed', detail });
    return record;
  };

  const create = async (
    context: unknown,
    draft: ServiceDraft,
    action: 'service.create' | 'service.duplicate',
  ): Promise<ServiceRecord> => {
    requireAuditPermission(context);
    const fields = readDraft(draft);
    const id = newId();
    // The unique key catches two creations minting one identifier in the same instant; this catches
    // an identifier that was already taken before either of them started.
    if ((await standing(context, id)) !== undefined) {
      throw new ServiceError('conflict', `${id} is a Service another writer named first`);
    }
    const at = options.now();
    const stamp = createdStamp({ id, kind: 'service', at, by: author(context).actor });
    const record = await stampOnto(context, stamp, { ...fields, state: 'upcoming' }, 1);
    return audited(context, record, action, action === 'service.create' ? 'Created a Service' : 'Duplicated a Service');
  };

  const restamp = async (
    context: unknown,
    id: string,
    change: (row: StampRow, at: string, by: string) => EntityStamp,
    detail: string,
  ): Promise<ServiceRecord | undefined> => {
    requireAuditPermission(context);
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    const at = options.now();
    const record = await stampOnto(context, change(row, at, author(context).actor), row, row.sequence + 1);
    return audited(context, record, 'service.archive', detail);
  };

  const lockedFor = (row: StampRow, alsoPresenting = false): void => {
    if (row.state === 'completed' || row.state === 'archived' || (alsoPresenting && row.state === 'presenting')) {
      throw new ServiceError('state', `${row.stamp.id} is ${row.state}; its order is kept as it was`);
    }
  };

  const mutateItems = async (
    context: unknown,
    id: string,
    action: AuditAction,
    detail: string,
    compute: (sections: readonly ServiceSection[]) => readonly ServiceSection[],
  ): Promise<ServiceRecord | undefined> => {
    requireAuditPermission(context);
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    lockedFor(row);
    const draft = readDraft({ title: row.title, date: row.date, site: row.site, sections: compute(row.sections) });
    const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
    const record = await stampOnto(context, stamp, { ...draft, state: row.state, output: row.output }, row.sequence + 1);
    return audited(context, record, action, detail);
  };

  return {
    create: (context, draft) => own(() => create(context, draft, 'service.create')),

    list: (context) =>
      own(async () => {
        const rows = await records.read(context, {});
        const byId = new Map<string, StampRow>();
        for (const found of rows) {
          const serviceId = found['serviceId'];
          if (typeof serviceId !== 'string') {
            throw new ServiceError('corrupt', 'a Service row is missing its identifier');
          }
          const row = rowFrom(serviceId, found);
          const current = byId.get(serviceId);
          if (current === undefined || current.sequence < row.sequence) byId.set(serviceId, row);
        }
        return [...byId.values()].map(({ stamp, title, date, site, state, sections, output }) => ({
          stamp,
          title,
          date,
          site,
          state,
          sections,
          ...(output === undefined ? {} : { output }),
        }));
      }),

    duplicate: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const { title, date, site, sections } = row;
        return create(context, { title, date, site, sections }, 'service.duplicate');
      }),

    schedule: (context, id, date) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (!isCalendarDay(date)) {
          throw new ServiceError('schema', 'service.date must be a calendar day such as 2026-09-13');
        }
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...row, date }, row.sequence + 1);
        return audited(context, record, 'service.schedule', 'Scheduled a Service');
      }),

    transition: (context, id, toState) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (!isCanonicalTransition(row.state, toState)) {
          throw new ServiceError(
            'state',
            `a Service cannot move from ${row.state} to ${toState}; only the next canonical ADR 0002 step is allowed`,
          );
        }
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...row, state: toState }, row.sequence + 1);
        return audited(
          context,
          record,
          'service.transition',
          `Transitioned a Service to ${SERVICE_STATE_LABELS[toState]}`,
        );
      }),

    edit: (context, id, sections) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        lockedFor(row);
        const draft = readDraft({ title: row.title, date: row.date, site: row.site, sections });
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...draft, state: row.state, output: row.output }, row.sequence + 1);
        return audited(context, record, 'service.edit', 'Edited a Service’s sections and items');
      }),

    setOutput: (context, id, output) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        lockedFor(row, true);
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...row, output }, row.sequence + 1);
        return audited(context, record, 'service.output', "Set a Service's output profile");
      }),

    addItem: (context, id, sectionId, item) =>
      own(() =>
        mutateItems(context, id, 'service.item.add', 'Added an item to a Service', (sections) =>
          withAddedItem(sections, sectionId, item),
        ),
      ),

    removeItem: (context, id, itemId) =>
      own(() =>
        mutateItems(context, id, 'service.item.remove', 'Removed an item from a Service', (sections) =>
          withoutItem(sections, itemId),
        ),
      ),

    enableItem: (context, id, itemId) =>
      own(() =>
        mutateItems(context, id, 'service.item.enable', 'Enabled a Service item', (sections) =>
          withChangedItem(sections, itemId, (item) => ({ ...item, enabled: true })),
        ),
      ),

    disableItem: (context, id, itemId) =>
      own(() =>
        mutateItems(context, id, 'service.item.disable', 'Disabled a Service item', (sections) =>
          withChangedItem(sections, itemId, (item) => ({ ...item, enabled: false })),
        ),
      ),

    duplicateItem: (context, id, itemId) =>
      own(() =>
        mutateItems(context, id, 'service.item.duplicate', 'Duplicated a Service item', (sections) =>
          withDuplicatedItem(sections, itemId, newId()),
        ),
      ),

    reorderItems: (context, id, sectionId, itemIds) =>
      own(() =>
        mutateItems(context, id, 'service.item.reorder', 'Reordered a Service section’s items', (sections) =>
          withReorderedItems(sections, sectionId, itemIds),
        ),
      ),

    reviseItem: (context, id, itemId, revision) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        lockedFor(row);
        const { sectionIndex, itemIndex } = locateItem(row.sections, itemId);
        const current = row.sections[sectionIndex]!.items[itemIndex]!.content;
        if (current === undefined) {
          throw new ServiceError('schema', `${itemId} has no content reference to revise`);
        }
        const found = await library.get(context, current.id);
        if (found === undefined) {
          throw new ServiceError('schema', `${current.id} does not name a library item this Service can reference`);
        }
        const target = await revisions.read(context, current.id, revision);
        if (target === undefined) {
          throw new ServiceError('schema', `${current.id} has no revision ${revision}`);
        }
        const ref: RevisionRef = { id: current.id, revision, hash: target.hash };
        const draft = readDraft({
          title: row.title, date: row.date, site: row.site,
          sections: withChangedItem(row.sections, itemId, (item) => ({ ...item, content: ref })),
        });
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...draft, state: row.state, output: row.output }, row.sequence + 1);
        return audited(context, record, 'service.item.revise', `Revised ${itemId} onto content revision ${revision}`);
      }),

    contentDrift: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const refs = row.sections.flatMap((section) =>
          section.items.flatMap((item) => (item.content === undefined ? [] : [{ itemId: item.id, content: item.content }])),
        );
        return Promise.all(
          refs.map(async ({ itemId, content }) => {
            const pinnedRevision = content.revision;
            const latest = await revisions.current(context, content.id);
            const latestRevision = latest?.revision ?? pinnedRevision;
            return { itemId, contentId: content.id, pinnedRevision, latestRevision, drifted: latestRevision !== pinnedRevision };
          }),
        );
      }),

    archive: (context, id) =>
      own(() => restamp(context, id, (row, at, by) => archivedStamp(row.stamp, { at, by }), 'Archived a Service')),

    unarchive: (context, id) =>
      own(() => restamp(context, id, (row, at, by) => restoredStamp(row.stamp, { at, by }), 'Unarchived a Service')),

    current: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const { stamp, title, date, site, state, sections, output } = row;
        return { stamp, title, date, site, state, sections, ...(output === undefined ? {} : { output }) };
      }),
  };
}
