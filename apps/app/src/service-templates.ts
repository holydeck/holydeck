// A Service Template's own record (spec TMPL-04): the name an Admin gave it, when it was defined, and by
// whom. This is deliberately smaller than `slide-layouts.ts`, the closest precedent, because a Service
// Template has no update verb yet — the specification does not say what changing or archiving one does, the
// same reason `@holydeck/contracts/entities`'s closed `ENTITY_KINDS` registry does not carry
// `serviceTemplate` (a kind is added there once a requirement says what archiving it does, not when code
// first needs to store one). So this store keeps no stamp history: a Service Template is created once, in
// full, and read back exactly as it was created. When a requirement settles what changing one means, an
// update path is added the way `slide-layouts.ts` added `version()` — not guessed here first.
//
// The entries themselves are still stored through `./revisions.js` rather than inline on this record,
// because that is this codebase's one content-storage mechanism, and because `create` always produces
// revision 1 for free from it — the same durable, hash-addressed storage TMPL-04's own "push into a new
// revision" text will need, whenever that is built.

import { randomBytes } from 'node:crypto';

import { parseServiceTemplateBody, parseServiceTemplateDraft } from '@holydeck/contracts/service-templates';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { REVISION_PERMISSIONS, RevisionError, revisionsOn } from './revisions.js';

import type { ServiceTemplateBody, ServiceTemplateDraft } from '@holydeck/contracts/service-templates';
import type { RevisionRecord } from '@holydeck/contracts/revisions';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionRefusal } from './revisions.js';

export const SERVICE_TEMPLATE_RECORD = 'serviceTemplates';

export const SERVICE_TEMPLATE_PERMISSIONS = permissionsFor(SERVICE_TEMPLATE_RECORD);

/** How a Service Template is named in the audit trail: never as a bare identifier that could be anything. */
export const subjectFor = (id: string): string => `serviceTemplate:${id}`;

/** The one context a Service Template is administered under: the two stores it spans, and nothing else. */
export function serviceTemplateContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(SERVICE_TEMPLATE_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS)],
    correlationId,
  });
}

export interface ServiceTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The same, plus the one revision of its entries that was asked for. */
export interface ServiceTemplatePreview extends ServiceTemplateRecord {
  readonly revision: number;
  readonly body: ServiceTemplateBody;
}

// TODO: no edit or archive verb yet — a Service Template is created once and read back exactly as it
// was, which is a gap for the seeded default this store holds (see seed.ts's "Known limitations").
// Revisit that note when this store settles its own update/archive semantics.
export interface ServiceTemplateStore {
  create(context: unknown, draft: ServiceTemplateDraft): Promise<ServiceTemplatePreview>;
  /** The entries a Service Template was created with, or nothing for one that was never created. */
  preview(context: unknown, id: string): Promise<ServiceTemplatePreview | undefined>;
  /** Every Service Template on file, without its entries — the same shape `create` stamps down first. */
  list(context: unknown): Promise<readonly ServiceTemplateRecord[]>;
}

export interface ServiceTemplateOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const TEMPLATE_ID_BYTES = 16;

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

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

const REVISION_REFUSALS: Readonly<Record<RevisionRefusal, ServiceTemplateRefusal>> = {
  schema: 'schema',
  missing: 'state',
  conflict: 'conflict',
  corrupt: 'corrupt',
};

function refusalFor(error: unknown): unknown {
  if (error instanceof RevisionError) return new ServiceTemplateError(REVISION_REFUSALS[error.kind], error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new ServiceTemplateError('conflict', `${error.message}, so another writer named this Service Template first`);
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

function readDraft(draft: ServiceTemplateDraft): ServiceTemplateDraft {
  const parsed = parseServiceTemplateDraft({ name: draft.name, ...draft.body });
  if (!parsed.ok) throw new ServiceTemplateError('schema', `this is not a Service Template: ${problems(parsed.problems)}`);
  return parsed.value;
}

export function serviceTemplatesOn(db: RepositoryDb, options: ServiceTemplateOptions): ServiceTemplateStore {
  const records = repositoriesOn(db)[SERVICE_TEMPLATE_RECORD];
  const revisions = revisionsOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(TEMPLATE_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  /** The one row a Service Template has, or nothing at all when no such Service Template was ever created. */
  const standing = async (context: unknown, id: string): Promise<ServiceTemplateRecord | undefined> => {
    const [found] = await records.read(context, { _id: id }, { limit: 1 });
    if (found === undefined) return undefined;
    const name = found['name'];
    const createdAt = found['createdAt'];
    const createdBy = found['createdBy'];
    if (typeof name !== 'string' || typeof createdAt !== 'string' || typeof createdBy !== 'string') {
      throw new ServiceTemplateError('corrupt', `${id} is stamped with fields this code cannot read`);
    }
    return { id, name, createdAt, createdBy };
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

  return {
    create: (context, draft) =>
      own(async () => {
        const { name, body } = readDraft(draft);
        const id = newId();
        if ((await standing(context, id)) !== undefined) {
          throw new ServiceTemplateError('conflict', `${id} is a Service Template another writer named first`);
        }
        const at = options.now();
        const outcome = await revisions.save(context, { contentId: id, body, origin: 'manual-checkpoint' });
        const createdBy = author(context).actor;
        await records.append(context, { _id: id, name, createdAt: at, createdBy, ...author(context) });
        return { id, name, createdAt: at, createdBy, revision: outcome.revision.revision, body: bodyOf(outcome.revision) };
      }),

    preview: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const record = await revisions.current(context, id);
        if (record === undefined) {
          throw new ServiceTemplateError('corrupt', `${id} is a Service Template and holds no entries at all`);
        }
        return { ...row, revision: record.revision, body: bodyOf(record) };
      }),

    list: (context) =>
      own(async () => {
        const rows = await records.read(context, {});
        return rows.map((found) => {
          const id = found['_id'];
          const name = found['name'];
          const createdAt = found['createdAt'];
          const createdBy = found['createdBy'];
          if (
            typeof id !== 'string' ||
            typeof name !== 'string' ||
            typeof createdAt !== 'string' ||
            typeof createdBy !== 'string'
          ) {
            throw new ServiceTemplateError('corrupt', 'a Service Template row is missing its identifier');
          }
          return { id, name, createdAt, createdBy };
        });
      }),
  };
}
