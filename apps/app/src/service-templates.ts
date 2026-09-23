// Service Templates: reusable service outlines an Admin defines, versioned and offered independently of
// any one Service (spec TMPL-04, AUTH-09).
//
// Composed the same way `slide-layouts.ts` composes its own two mechanisms, and for the same reason:
// `@holydeck/contracts/entities` stamps say whether a Service Template is offered where Templates are
// chosen — created, saved forward, archived, brought back — and nothing about what its entries are.
// `./revisions.js` says what its entries are over time, and nothing about whether anyone may still choose
// it. So a Service Template is one entity stamp and N revisions, exactly like a Slide Layout: archiving
// one leaves its entries exactly where they were, and versioning one leaves its visibility exactly where
// it was.
//
// The stamp is kept as a history of its own, one row per change, `sequence` counting from one, for the
// reason `slide-layouts.ts`'s header settles: neither mechanism under it has an update verb, and two
// writers reaching the same ordinal collide on the key rather than on the record. `create` writes the
// entries first, `version`/`archive`/`unarchive` write the stamp first — the same ordering, for the same
// reasons `slide-layouts.ts` gives them.
//
// `fromService` is the one verb with no Slide Layout counterpart: it mints a new Service Template from an
// existing Service's own sections and items, through `@holydeck/contracts/service-templates`'s
// `templateFromService`, which only ever reads the Service it converts. It is a `create` whose entries
// come from a Service rather than from a caller's own draft, and shares `create`'s identifier-minting and
// conflict handling rather than duplicating them.

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
  parseServiceTemplateBody,
  parseServiceTemplateDraft,
  templateFromService,
} from '@holydeck/contracts/service-templates';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { REVISION_PERMISSIONS, RevisionError, addressOf, revisionsOn } from './revisions.js';
import { SERVICE_PERMISSIONS } from './services.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { ServiceTemplateBody, ServiceTemplateDraft } from '@holydeck/contracts/service-templates';
import type { RevisionRecord } from '@holydeck/contracts/revisions';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionRefusal } from './revisions.js';
import type { ServiceStore } from './services.js';

/** The record class the stamps live in. Named once, because the permissions and the index read off it. */
export const SERVICE_TEMPLATE_RECORD = 'serviceTemplates';

export const SERVICE_TEMPLATE_PERMISSIONS = permissionsFor(SERVICE_TEMPLATE_RECORD);

/** How a Service Template is named in the audit trail: never as a bare identifier that could be anything. */
export const subjectFor = (id: string): string => `serviceTemplate:${id}`;

export interface ServiceTemplateIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and every read this store makes is served by it: the standing stamp of one Service Template.
// Unique, so the rule that a stamp history grows by one is the database's too, and not only this file's.
const DECLARED_INDEXES: readonly ServiceTemplateIndex[] = [
  { name: 'service_template_stamp', keys: { templateId: 1, sequence: -1 }, options: { unique: true } },
];

export const SERVICE_TEMPLATE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type ServiceTemplateRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a bad payload from a race it lost fairly. */
export class ServiceTemplateError extends Error {
  readonly kind: ServiceTemplateRefusal;

  constructor(kind: ServiceTemplateRefusal, message: string) {
    super(message);
    this.name = 'ServiceTemplateError';
    this.kind = kind;
  }
}

/** The one context a Service Template is administered under: the three stores it spans, and nothing else. */
export function serviceTemplateContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(SERVICE_TEMPLATE_PERMISSIONS),
      ...Object.values(REVISION_PERMISSIONS),
      ...Object.values(SERVICE_PERMISSIONS),
    ],
    correlationId,
  });
}

/** A Service Template as it is administered: whether it is offered, and what it is called. */
export interface ServiceTemplateRecord {
  readonly stamp: EntityStamp;
  readonly name: string;
}

/** The same, plus the one version of its entries that was asked for. */
export interface ServiceTemplatePreview extends ServiceTemplateRecord {
  readonly revision: number;
  readonly at: string;
  readonly body: ServiceTemplateBody;
}

export interface VersionOutcome {
  /** False when the entries did not change: the ordinal below is the one that already stood. */
  readonly appended: boolean;
  /** True when the name changed, whether or not the entries did — a new stamp row either way. */
  readonly renamed: boolean;
  readonly revision: number;
}

export interface ServiceTemplateStore {
  create(context: unknown, draft: ServiceTemplateDraft): Promise<ServiceTemplatePreview>;
  /** Every Service Template's standing stamp. */
  list(context: unknown): Promise<readonly ServiceTemplateRecord[]>;
  /** The standing entries, or a named earlier ordinal. Nothing is written either way. */
  preview(context: unknown, id: string, revision?: number): Promise<ServiceTemplatePreview | undefined>;
  /** Saves the name and entries forward. Nothing for an unknown Template; nothing appended when the
   *  entries did not change, but a changed name is still saved onto a new stamp row either way. */
  version(context: unknown, id: string, draft: ServiceTemplateDraft): Promise<VersionOutcome | undefined>;
  /** Stops offering it where Templates are chosen. Its entries and its history are untouched. */
  archive(context: unknown, id: string): Promise<ServiceTemplateRecord | undefined>;
  /** Offers it again. Its entries are untouched either way. */
  unarchive(context: unknown, id: string): Promise<ServiceTemplateRecord | undefined>;
  history(context: unknown, id: string): Promise<readonly RevisionRecord[]>;
  /** A new Service Template minted from an existing Service's own sections and items. Nothing for a
   *  Service that was never created; the Service itself is only ever read. */
  fromService(context: unknown, serviceId: string, name: string): Promise<ServiceTemplatePreview | undefined>;
}

export interface ServiceTemplateOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
  /** `fromService` reads through this store; it writes nothing here and needs nothing more of it. */
  readonly services: ServiceStore;
}

const TEMPLATE_ID_BYTES = 16;

const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

// A revision refusal said again in this store's vocabulary. `missing` is the only one that changes name:
// a revision the caller asked for and history does not have is the state it is in, not a bad payload.
const REVISION_REFUSALS: Readonly<Record<RevisionRefusal, ServiceTemplateRefusal>> = {
  schema: 'schema',
  missing: 'state',
  conflict: 'conflict',
  corrupt: 'corrupt',
};

/**
 * Every refusal the composed mechanisms raise, said in this store's own words — so a caller of a Service
 * Template never has to know which of them answered. Anything else is passed through untouched: the
 * records layer's own refusals about context and permission are already the clearest statement of what
 * went wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new ServiceTemplateError('state', error.message);
  if (error instanceof RevisionError) return new ServiceTemplateError(REVISION_REFUSALS[error.kind], error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new ServiceTemplateError(
      'conflict',
      `${error.message}, so another writer stamped this Service Template first`,
    );
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

/** The entries, graded before they are stored and again before they are served. */
function readBody(value: unknown): ServiceTemplateBody {
  const parsed = parseServiceTemplateBody(value);
  if (!parsed.ok) {
    throw new ServiceTemplateError(
      'schema',
      `these are not entries a Service Template is built from: ${problems(parsed.problems)}`,
    );
  }
  return parsed.value;
}

/** The name and the entries together, which is what a new Service Template is. */
function readDraft(draft: ServiceTemplateDraft): ServiceTemplateDraft {
  const parsed = parseServiceTemplateDraft({ name: draft.name, ...draft.body });
  if (!parsed.ok) throw new ServiceTemplateError('schema', `this is not a Service Template: ${problems(parsed.problems)}`);
  return parsed.value;
}

/** What one stamp row holds, once it has been read back as something this build understands. */
interface StampRow {
  readonly stamp: EntityStamp;
  readonly name: string;
  readonly sequence: number;
}

export function serviceTemplatesOn(db: RepositoryDb, options: ServiceTemplateOptions): ServiceTemplateStore {
  const records = repositoriesOn(db)[SERVICE_TEMPLATE_RECORD];
  const revisions = revisionsOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(TEMPLATE_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    // Nothing is checked here: every call below has already read through the repository by this point, and
    // that layer refuses a context it cannot read as surely as it refuses an actor who may not append.
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  /** What one stamp row holds, once it has been read back as something this build understands. */
  const rowFrom = (id: string, found: Record<string, unknown>): StampRow => {
    const name = found['name'];
    const sequence = found['sequence'];
    if (typeof name !== 'string' || typeof sequence !== 'number') {
      throw new ServiceTemplateError('corrupt', `${id} is stamped with a name or an ordinal this code cannot read`);
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new ServiceTemplateError('corrupt', `${id} holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return { stamp: parsed.value, name, sequence };
  };

  /** The standing stamp of one Service Template, or nothing at all when no such Template was ever created. */
  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { templateId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(id, found);
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    name: string,
    sequence: number,
  ): Promise<ServiceTemplateRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      templateId: stamp.id,
      sequence,
      at: stamp.updatedAt,
      name,
      stamp,
      ...author(context),
    });
    return { stamp, name };
  };

  /** The entries a stored revision holds, graded on the way out for the reason the revision store grades. */
  const bodyOf = (record: RevisionRecord): ServiceTemplateBody => {
    const parsed = parseServiceTemplateBody(record.body);
    if (!parsed.ok) {
      throw new ServiceTemplateError(
        'corrupt',
        `revision ${record.revision} of ${record.contentId} holds entries this code cannot read: ${problems(parsed.problems)}`,
      );
    }
    return parsed.value;
  };

  /**
   * A version saved forward: the stamp first and the entries after it, for the reason the header settles.
   * `hash` is the address the entries about to be saved will be stored under, and it is what answers
   * whether this is a change at all — asked here rather than left to the revision store, because by the
   * time the store could answer it the stamp would already be written.
   */
  const saved = async (
    context: unknown,
    id: string,
    row: StampRow,
    name: string,
    hash: string,
    save: () => Promise<{ readonly appended: boolean; readonly revision: RevisionRecord }>,
  ): Promise<VersionOutcome> => {
    const at = options.now();
    // Before anything is written: an archived Template is one nothing changes, and `touchedStamp` says so.
    const touched = touchedStamp(row.stamp, { at, by: author(context).actor });
    const held = await revisions.current(context, id);
    // A stamp is only ever written after the entries it names, so a Template that has one has entries. One
    // that does not is a Template whose history went somewhere this product cannot write, and saying so is
    // the only honest answer: starting its history over would bury whatever took it.
    if (held === undefined) {
      throw new ServiceTemplateError('corrupt', `${id} is stamped as a Service Template and holds no entries at all`);
    }
    const entriesChanged = held.hash !== hash;
    const renamed = name !== row.name;
    // Neither changed: nothing to save, and nothing is written — not even a touch, matching how a save
    // with unchanged entries alone always behaved here.
    if (!entriesChanged && !renamed) return { appended: false, renamed: false, revision: held.revision };
    // A stamp row is written whenever the name changed even if the entries did not, or a rename made
    // through this same save would otherwise never reach the row that holds it.
    await stampOnto(context, touched, name, row.sequence + 1);
    if (!entriesChanged) return { appended: false, renamed: true, revision: held.revision };
    const outcome = await save();
    return { appended: outcome.appended, renamed, revision: outcome.revision.revision };
  };

  const restamp = async (
    context: unknown,
    id: string,
    change: (row: StampRow, at: string, by: string) => EntityStamp,
  ): Promise<ServiceTemplateRecord | undefined> => {
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    const at = options.now();
    return stampOnto(context, change(row, at, author(context).actor), row.name, row.sequence + 1);
  };

  /** `create`'s own body, shared with `fromService`: mint an identifier, stamp it, save the first revision. */
  const define = async (context: unknown, name: string, body: ServiceTemplateBody): Promise<ServiceTemplatePreview> => {
    const id = newId();
    // Here the entries go first, so this is the one path where appending them onto a Template somebody
    // else already stands on would make the loser's entries the winner's content. The unique key behind
    // the stamp still catches two creations minting one identifier in the same instant; this catches an
    // identifier that was already taken before either of them started.
    if ((await standing(context, id)) !== undefined) {
      throw new ServiceTemplateError('conflict', `${id} is a Service Template another writer named first`);
    }
    const at = options.now();
    const outcome = await revisions.save(context, { contentId: id, body, origin: 'manual-checkpoint' });
    const stamp = createdStamp({ id, kind: 'serviceTemplate', at, by: author(context).actor });
    await stampOnto(context, stamp, name, 1);
    return { stamp, name, revision: outcome.revision.revision, at: outcome.revision.at, body };
  };

  return {
    create: (context, draft) =>
      own(async () => {
        const { name, body } = readDraft(draft);
        return define(context, name, body);
      }),

    list: (context) =>
      own(async () => {
        const rows = await records.read(context, {});
        const byId = new Map<string, StampRow>();
        for (const found of rows) {
          const templateId = found['templateId'];
          if (typeof templateId !== 'string') {
            throw new ServiceTemplateError('corrupt', 'a Service Template row is missing its identifier');
          }
          const row = rowFrom(templateId, found);
          const current = byId.get(templateId);
          if (current === undefined || current.sequence < row.sequence) byId.set(templateId, row);
        }
        return [...byId.values()].map((row) => ({ stamp: row.stamp, name: row.name }));
      }),

    preview: (context, id, revision) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const record =
          revision === undefined
            ? await revisions.current(context, id)
            : await revisions.read(context, id, revision);
        if (record === undefined) return undefined;
        return { stamp: row.stamp, name: row.name, revision: record.revision, at: record.at, body: bodyOf(record) };
      }),

    version: (context, id, draft) =>
      own(async () => {
        const { name, body: entries } = readDraft(draft);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return saved(context, id, row, name, addressOf(entries), () =>
          revisions.save(context, { contentId: id, body: entries, origin: 'manual-checkpoint' }),
        );
      }),

    archive: (context, id) => own(() => restamp(context, id, (row, at, by) => archivedStamp(row.stamp, { at, by }))),

    unarchive: (context, id) =>
      own(() => restamp(context, id, (row, at, by) => restoredStamp(row.stamp, { at, by }))),

    history: (context, id) => own(() => revisions.history(context, id)),

    fromService: (context, serviceId, name) =>
      own(async () => {
        const service = await options.services.current(context, serviceId);
        if (service === undefined) return undefined;
        const body = readBody(
          templateFromService({
            id: service.stamp.id,
            title: service.title,
            date: service.date,
            site: service.site,
            state: service.state,
            sections: service.sections,
          }),
        );
        const { name: readName } = readDraft({ name, body });
        return define(context, readName, body);
      }),
  };
}
