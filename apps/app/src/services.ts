import { randomBytes } from 'node:crypto';

import {
  EntityError,
  archivedStamp,
  createdStamp,
  parseEntityStamp,
  restoredStamp,
  touchedStamp,
} from '@holydeck/contracts/entities';
import { isCalendarDay, parseService, parseServiceDraft } from '@holydeck/contracts/services';

import { auditOn } from './audit.js';
import { contextProblems, requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { ServiceDraft, ServiceSection, ServiceState } from '@holydeck/contracts/services';

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
    permissions: [...Object.values(SERVICE_PERMISSIONS), permissionsFor('auditEvents').append],
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
}

export interface ServiceStore {
  create(context: unknown, draft: ServiceDraft): Promise<ServiceRecord>;
  /** A new Service with the same title, date, site, and sections/items — items keep their own
   *  RevisionRef verbatim (same id/revision/hash), never copying the content it points to. Fresh
   *  id, fresh entity stamp, state starts at 'upcoming' regardless of the source's state. */
  duplicate(context: unknown, id: string): Promise<ServiceRecord | undefined>;
  /** Changes the date only. Never touches state. */
  schedule(context: unknown, id: string, date: string): Promise<ServiceRecord | undefined>;
  /** Changes sections/items. Never touches title, date, site, or state. */
  edit(context: unknown, id: string, sections: readonly ServiceSection[]): Promise<ServiceRecord | undefined>;
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

export function servicesOn(db: RepositoryDb, options: ServiceOptions): ServiceStore {
  const records = repositoriesOn(db)[SERVICE_RECORD];
  const trail = auditOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(SERVICE_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { serviceId: id }, { sort: { sequence: -1 }, limit: 1 });
    if (found === undefined) return undefined;
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
    const { title, date, site, state, sections } = service.value;
    return { stamp: parsed.value, title, date, site, state, sections, sequence };
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    fields: ServiceDraft & { readonly state: ServiceState },
    sequence: number,
  ): Promise<ServiceRecord> => {
    const { title, date, site, state, sections } = fields;
    const record = { stamp, title, date, site, state, sections };
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

  return {
    create: (context, draft) => own(() => create(context, draft, 'service.create')),

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

    edit: (context, id, sections) =>
      own(async () => {
        requireAuditPermission(context);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const draft = readDraft({ title: row.title, date: row.date, site: row.site, sections });
        const stamp = touchedStamp(row.stamp, { at: options.now(), by: author(context).actor });
        const record = await stampOnto(context, stamp, { ...draft, state: row.state }, row.sequence + 1);
        return audited(context, record, 'service.edit', 'Edited a Service’s sections and items');
      }),

    archive: (context, id) =>
      own(() => restamp(context, id, (row, at, by) => archivedStamp(row.stamp, { at, by }), 'Archived a Service')),

    unarchive: (context, id) =>
      own(() => restamp(context, id, (row, at, by) => restoredStamp(row.stamp, { at, by }), 'Unarchived a Service')),

    current: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const { stamp, title, date, site, state, sections } = row;
        return { stamp, title, date, site, state, sections };
      }),
  };
}
