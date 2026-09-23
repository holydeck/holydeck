// The administrative trail, written through the durable record class that holds it.
//
// Spec ADMN-03 asks for an append-only trail, and `records.ts` already refuses to rewrite one. What this
// module adds is the vocabulary: an entry names an action out of a declared list, so the trail can be
// enumerated by someone reading this file rather than discovered by reading every caller. An action
// nothing declares is refused, which is the same promise the record classes make about field names.
//
// Nothing here is ever handed a password or a token. `subject` names what was acted on and `detail` says
// why in prose meant for a person, and both are written as given bar the narrowing `scrubAuditText` does
// to addresses and URL passwords — so a caller passing any other secret into either has put it in the
// trail, which is the one thing the trail must never hold.

import { randomBytes } from 'node:crypto';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { RequestContext } from './context.js';
import type { RecordName } from './records.js';
import type { Document, Filter, RepositoryDb } from './repositories.js';
import type { IntegrationCallInfo } from '@holydeck/core/sermon-ai';

/** Every action this release records. One entry per thing an administrator can be answerable for. */
export const AUDIT_ACTIONS = [
  'instance.claim',
  'session.signIn',
  'session.lock',
  // A second factor is its own small history: enrolling one, proving it, spending a code at a sign-in,
  // drawing fresh recovery codes, and giving it up. The trail holds the account it happened to and
  // never the secret, the code, or a recovery code — those live in `totp.ts` and go no further.
  'totp.enroll',
  'totp.verify',
  'totp.use',
  'totp.regenerate',
  'totp.revoke',
  // A passkey has the same small history, minus a secret to keep: registering one, renaming it, signing
  // in with it, and giving it up. The trail holds the key's identifier, which is public by construction,
  // and never the public key, the challenge or the signature.
  'passkey.register',
  'passkey.name',
  'passkey.use',
  'passkey.revoke',
  // Granting or revoking Control presentation, apart from the three roles. An account being created,
  // closed, reopened, or reassigned which of the three roles it holds has its own entry beside this one.
  'account.control',
  'account.create',
  'account.disable',
  'account.restore',
  'account.role',
  // A proven session refused for lacking a permission its route required. The one server-wide check that
  // decides what a session may do, as opposed to who it is — `session.signIn`'s refusal covers the latter.
  'authorization.refuse',
  // A browser-container gaining a second (or third) authenticated slot, and the container's own pointer
  // moving between the slots it already holds. Neither entry ever carries a permission or a token.
  'session.slot.add',
  'session.slot.switch',
  // A Guest's invitation or an output window's capability, issued or given back before it was ever spent.
  // The trail holds the operator who acted and the service and view in prose, and never the token.
  'capability.guest.issue',
  'capability.output.issue',
  'capability.revoke',
  // The settings file, administered as the one thing it is: a change is recorded once, naming only
  // which fields it touched and never a value — viewing it is never audited, the same as any other GET.
  'settings.update',
  // Every change to a piece of content, whatever the surface: `slide-layout-routes.ts` is its first
  // caller, and names the Layout in the subject and the direction in the detail rather than adding a
  // verb per surface. Most content surfaces after it join this action; a surface the spec calls out for
  // its own action, such as PPTX below (AUTH-04), is a documented exception rather than the norm.
  'content.change',
  // PPTX import's own history, kept apart from `content.change` because AUTH-04 asks for it by name: the
  // upload (including a refused one) and the commit that turns a reviewed import into a Song.
  'pptx.import',
  'pptx.commit',
  // A Service Template's own history, apart from `content.change`: creating stays on the shared action
  // (TMPL-04, AUTH-09), but saving forward, archiving, bringing back and converting from a Service each
  // get their own, per the same spec.
  'serviceTemplate.version',
  'serviceTemplate.archive',
  'serviceTemplate.unarchive',
  'serviceTemplate.fromService',
  // A Service's own history: creating, duplicating, scheduling, archiving/unarchiving, transitioning
  // through its lifecycle, and editing its sections and items. `services.ts` is the only caller — no
  // routes task exists yet to carry this the way `accounts-routes.ts` carries `account.*`, so the
  // store appends these itself.
  'service.create',
  'service.duplicate',
  'service.schedule',
  'service.archive',
  'service.edit',
  'service.transition',
  'service.output',
  // A Service item's own history: adding, removing, enabling, disabling, duplicating, and reordering
  // items within a Service's sections. Same caller as the service-level actions above — `services.ts`.
  'service.item.add',
  'service.item.body',
  'service.item.remove',
  'service.item.enable',
  'service.item.disable',
  'service.item.duplicate',
  'service.item.reorder',
  'service.item.revise',
  // A presentation run's own lifecycle: starting one and ending one. `runs.ts` is the only caller —
  // distinct actions rather than one shared name, so the trail can be filtered to just starts or just
  // ends without parsing `detail`.
  'run.start',
  'run.end',
  // The rest of a run's own history LIVE-01 asks the trail to answer for: its theme changed, content
  // joined it mid-service, or its recap left the server as a download. `run-routes.ts` is the only
  // caller — `run.start`/`run.end` above are `runs.ts`'s own, the same split this file already draws
  // between a store's actions and a routes task's.
  'run.theme',
  'run.addition',
  'run.recap.export',
  // An Operator taking a Service live over an open blocker. Written by `snapshots.ts` itself — no routes
  // task owns the readiness surface yet — and naming the Operator, the reason, and every check carried.
  'readiness.override',
  // Reserved for the backup surface T100+ builds. Exercised only by this task's own tests today.
  'backup.run',
  // Reserved for the restore surface T101+ builds. Exercised only by this task's own tests today.
  'restore.run',
  // A losing edit's shelf row settled: `collaboration.ts`'s own caller, naming which revision won.
  'content.conflict.resolve',
  // An earlier revision brought back over what a piece of content held: `revision-routes.ts`'s restore.
  'content.revision.restore',
  // A third-party integration reached, and given up: the sermon-AI surface's own two entries, spec v1c-09.
  'integration.call',
  'integration.enable',
  'integration.disable',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The eight kinds of thing ADMN-03 and ADMN-04 ask the trail to answer for, spanning every action above. */
export const AUDIT_CATEGORIES = [
  'authentication',
  'authorization',
  'settings',
  'content',
  'presentation',
  'backup',
  'restore',
  'integration',
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Every action's category, so an entry can be filtered by the kind of thing it answers for without
 * parsing its name. `authentication` proves who the actor is; `authorization` grants, revokes or checks
 * what that actor may do — a distinction this map is what makes assertable rather than merely intended.
 */
export const CATEGORY_OF: Readonly<Record<AuditAction, AuditCategory>> = {
  'instance.claim': 'authentication',
  'session.signIn': 'authentication',
  'session.lock': 'authentication',
  'totp.enroll': 'authentication',
  'totp.verify': 'authentication',
  'totp.use': 'authentication',
  'totp.regenerate': 'authentication',
  'totp.revoke': 'authentication',
  'passkey.register': 'authentication',
  'passkey.name': 'authentication',
  'passkey.use': 'authentication',
  'passkey.revoke': 'authentication',
  'session.slot.add': 'authentication',
  'session.slot.switch': 'authentication',
  'account.control': 'authorization',
  'account.create': 'authorization',
  'account.disable': 'authorization',
  'account.restore': 'authorization',
  'account.role': 'authorization',
  'capability.guest.issue': 'authorization',
  'capability.output.issue': 'authorization',
  'capability.revoke': 'authorization',
  'authorization.refuse': 'authorization',
  'settings.update': 'settings',
  'content.change': 'content',
  'pptx.import': 'content',
  'pptx.commit': 'content',
  'serviceTemplate.version': 'content',
  'serviceTemplate.archive': 'content',
  'serviceTemplate.unarchive': 'content',
  'serviceTemplate.fromService': 'content',
  'service.create': 'content',
  'service.duplicate': 'content',
  'service.schedule': 'content',
  'service.archive': 'content',
  'service.edit': 'content',
  'service.transition': 'content',
  'service.output': 'content',
  'service.item.add': 'content',
  'service.item.body': 'content',
  'service.item.remove': 'content',
  'service.item.enable': 'content',
  'service.item.disable': 'content',
  'service.item.duplicate': 'content',
  'service.item.reorder': 'content',
  'service.item.revise': 'content',
  'run.start': 'presentation',
  'run.end': 'presentation',
  'run.theme': 'presentation',
  'run.addition': 'presentation',
  'run.recap.export': 'presentation',
  'readiness.override': 'presentation',
  'backup.run': 'backup',
  'restore.run': 'restore',
  'content.conflict.resolve': 'content',
  'content.revision.restore': 'content',
  'integration.call': 'integration',
  'integration.enable': 'integration',
  'integration.disable': 'integration',
};

/** Whether the thing the actor asked for happened. A refusal is recorded exactly as an allowance is. */
export type AuditOutcome = 'allowed' | 'refused';

/** The record class this store owns. Named once, because the migration that indexes it reads off it. */
export const AUDIT_RECORD: RecordName = 'auditEvents';

export interface AuditIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// `audit_time` already exists, from the trail's own first migration. This is the second: a listing
// narrowed to one category still wants its newest-first order, and a collection scan cannot give it that.
const DECLARED_INDEXES: readonly AuditIndex[] = [{ name: 'audit_category', keys: { category: 1, at: -1 }, options: {} }];

export const AUDIT_INDEXES = Object.freeze(DECLARED_INDEXES);

export interface AuditEntry {
  readonly action: AuditAction;
  /** What was acted on: an actor, a handle that was asked for, a service. Never a secret. */
  readonly subject: string;
  readonly outcome: AuditOutcome;
  /** Why, for a person reading the trail later. Never a secret. */
  readonly detail?: string;
  /** What an `integration.call` cost, in tokens. Never set by any other action. */
  readonly requestTokens?: number;
  readonly responseTokens?: number;
  readonly durationMs?: number;
}

/** One written entry, read back: everything `AuditEntry` carries, plus what `record()` stamped on it. */
export interface AuditRecordRead extends AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly category: AuditCategory;
  readonly actor: string;
  readonly correlationId: string;
}

export interface AuditListQuery {
  readonly category?: AuditCategory;
  readonly action?: AuditAction;
  readonly actor?: string;
  readonly outcome?: AuditOutcome;
  /** An inclusive ISO instant bound: `from` and `to` narrow `at`, either or both. */
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: { readonly at: string; readonly id: string };
  readonly limit: number;
}

export interface AuditPage {
  readonly entries: readonly AuditRecordRead[];
  readonly nextCursor?: { readonly at: string; readonly id: string };
}

export interface AuditTrail {
  /** Appends one entry and answers with its identifier. */
  record(context: unknown, entry: AuditEntry): Promise<string>;
  /** Newest first, redacted the way `AUDIT_DETAIL_REDACTION` says its action is. */
  list(context: unknown, query: AuditListQuery): Promise<AuditPage>;
}

export interface AuditOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

const ID_BYTES = 12;

/**
 * Every current action defaults to `'verbatim'` — this file's own header already guarantees no `detail`
 * string carries a secret, and `scrubAuditText` narrows whatever address or URL password one carries
 * anyway. A `detail` is one prose string rather than a map of keys, so there is no per-key allow-list to
 * keep: `'omit'` withholds an action's detail whole. An action added above without an entry here fails to compile, the map being
 * `Record<AuditAction, ...>`, and the exhaustiveness test in `audit.test.ts` fails with it.
 */
export const AUDIT_DETAIL_REDACTION: Readonly<Record<AuditAction, 'verbatim' | 'omit'>> = {
  'instance.claim': 'verbatim',
  'session.signIn': 'verbatim',
  'session.lock': 'verbatim',
  'totp.enroll': 'verbatim',
  'totp.verify': 'verbatim',
  'totp.use': 'verbatim',
  'totp.regenerate': 'verbatim',
  'totp.revoke': 'verbatim',
  'passkey.register': 'verbatim',
  'passkey.name': 'verbatim',
  'passkey.use': 'verbatim',
  'passkey.revoke': 'verbatim',
  'account.control': 'verbatim',
  'account.create': 'verbatim',
  'account.disable': 'verbatim',
  'account.restore': 'verbatim',
  'account.role': 'verbatim',
  'authorization.refuse': 'verbatim',
  'session.slot.add': 'verbatim',
  'session.slot.switch': 'verbatim',
  'capability.guest.issue': 'verbatim',
  'capability.output.issue': 'verbatim',
  'capability.revoke': 'verbatim',
  'settings.update': 'verbatim',
  'content.change': 'verbatim',
  'pptx.import': 'verbatim',
  'pptx.commit': 'verbatim',
  'serviceTemplate.version': 'verbatim',
  'serviceTemplate.archive': 'verbatim',
  'serviceTemplate.unarchive': 'verbatim',
  'serviceTemplate.fromService': 'verbatim',
  'service.create': 'verbatim',
  'service.duplicate': 'verbatim',
  'service.schedule': 'verbatim',
  'service.archive': 'verbatim',
  'service.edit': 'verbatim',
  'service.transition': 'verbatim',
  'service.output': 'verbatim',
  'service.item.add': 'verbatim',
  'service.item.body': 'verbatim',
  'service.item.remove': 'verbatim',
  'service.item.enable': 'verbatim',
  'service.item.disable': 'verbatim',
  'service.item.duplicate': 'verbatim',
  'service.item.reorder': 'verbatim',
  'service.item.revise': 'verbatim',
  'run.start': 'verbatim',
  'run.end': 'verbatim',
  'run.theme': 'verbatim',
  'run.addition': 'verbatim',
  'run.recap.export': 'verbatim',
  'readiness.override': 'verbatim',
  'backup.run': 'verbatim',
  'restore.run': 'verbatim',
  'content.conflict.resolve': 'verbatim',
  'content.revision.restore': 'verbatim',
  'integration.call': 'verbatim',
  'integration.enable': 'verbatim',
  'integration.disable': 'verbatim',
};

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\b/gu;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})\b/giu;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu;
const IPV6_KEPT_GROUPS = 3;
const IPV6_MIN_COLONS = 3;

/**
 * What the trail keeps of a subject or a detail: an IPv4 address narrowed to its /24 and an IPv6 one to
 * its /48, and the password in any `scheme://user:password@` URL replaced. No caller passes either today,
 * but `detail` is free prose — a corpus address, a restore's error message — and COLAB-10 asks that no
 * address beyond /24 and no credential ever comes back out, so it is enforced here rather than promised.
 * Run when an entry is written and again when one is read, so a row written before this existed is held
 * to the same rule. An IPv6 match needs three colons, which keeps a clock time like `09:30:00` intact.
 */
export function scrubAuditText(text: string): string {
  return text
    .replace(URL_PASSWORD, '$1[redacted]@')
    .replace(IPV4, '$1.$2.$3.0/24')
    .replace(IPV6, (address) =>
      address.split(':').length - 1 < IPV6_MIN_COLONS
        ? address
        : `${address.split(':').slice(0, IPV6_KEPT_GROUPS).join(':')}::/48`,
    );
}

export function redactAuditDetail(action: AuditAction, detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  return AUDIT_DETAIL_REDACTION[action] === 'verbatim' ? scrubAuditText(detail) : undefined;
}

function auditIdIn(_id: unknown): string {
  const id = String(_id);
  return id.startsWith('audit:') ? id.slice('audit:'.length) : id;
}

function graded(document: Document): AuditRecordRead {
  const action = document['action'] as AuditAction;
  return {
    action,
    subject: scrubAuditText(document['subject'] as string),
    outcome: document['outcome'] as AuditOutcome,
    detail: redactAuditDetail(action, document['detail'] as string | undefined),
    id: auditIdIn(document['_id']),
    at: document['at'] as string,
    // Read from the action rather than the row: rows written before the category was stored have none,
    // and an action's category is a fact of this release, not of the moment the row was written. A row
    // whose action this release no longer declares keeps whatever it stored.
    category: CATEGORY_OF[action] ?? (document['category'] as AuditCategory),
    actor: document['actor'] as string,
    correlationId: document['correlationId'] as string,
  };
}

export function auditOn(db: RepositoryDb, options: AuditOptions): AuditTrail {
  const newId = options.newId ?? ((): string => randomBytes(ID_BYTES).toString('base64url'));
  const events = repositoriesOn(db).auditEvents;
  const trail: AuditTrail = {
    async record(context, entry) {
      if (!AUDIT_ACTIONS.includes(entry.action)) {
        // A record class refuses a field it does not declare; this refuses an action, for the same reason.
        throw new RepositoryError('schema', `auditEvents: ${entry.action} is not an action the trail declares`);
      }
      // `append` proves the context before anything is written, and writes `actor` and `correlationId`
      // from it rather than from the caller, so the entry cannot be filed under another name.
      const checked = context as RequestContext;
      return events.append(context, {
        _id: `audit:${newId()}`,
        actor: checked.actor,
        correlationId: checked.correlationId,
        at: options.now(),
        action: entry.action,
        category: CATEGORY_OF[entry.action],
        subject: scrubAuditText(entry.subject),
        outcome: entry.outcome,
        ...(entry.detail === undefined ? {} : { detail: scrubAuditText(entry.detail) }),
        ...(entry.requestTokens === undefined ? {} : { requestTokens: entry.requestTokens }),
        ...(entry.responseTokens === undefined ? {} : { responseTokens: entry.responseTokens }),
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      });
    },
    async list(context, query) {
      const clauses: Filter[] = [];
      if (query.category !== undefined) {
        // By the category's member actions, so history from before the category was stored still answers
        // to it; the stored field is kept as one more branch for a row whose action is no longer declared.
        const members = AUDIT_ACTIONS.filter((action) => CATEGORY_OF[action] === query.category);
        clauses.push({ $or: [{ category: query.category }, ...members.map((action) => ({ action }))] });
      }
      if (query.action !== undefined) clauses.push({ action: query.action });
      if (query.actor !== undefined) clauses.push({ actor: query.actor });
      if (query.outcome !== undefined) clauses.push({ outcome: query.outcome });
      if (query.from !== undefined || query.to !== undefined) {
        const at: Record<string, string> = {};
        if (query.from !== undefined) at['$gte'] = query.from;
        if (query.to !== undefined) at['$lte'] = query.to;
        clauses.push({ at });
      }
      if (query.cursor !== undefined) {
        const { at, id } = query.cursor;
        clauses.push({ $or: [{ at: { $lt: at } }, { at, _id: { $lt: `audit:${id}` } }] });
      }
      const filter: Filter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0]! : { $and: clauses };

      const rows = await events.read(context, filter, { sort: { at: -1, _id: -1 }, limit: query.limit + 1 });
      const page = rows.slice(0, query.limit).map(graded);
      const last = page[page.length - 1];
      const nextCursor = rows.length > query.limit && last !== undefined ? { at: last.at, id: last.id } : undefined;
      return { entries: page, nextCursor };
    },
  };
  return Object.freeze(trail);
}

/** The context the server writes its own trail under: able to append an entry, and to do nothing else. */
export function auditContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [permissionsFor('auditEvents').append], correlationId });
}

/** The context an admin reads the trail under: able to list it, and to do nothing else. */
export function auditReadContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [permissionsFor('auditEvents').read], correlationId });
}

/**
 * Adapts sermon-ai.ts's (spec v1c-08, package @holydeck/core) onIntegrationCall callback shape onto this
 * file's own AuditTrail.record(), so a call site only has to pass this closure through, not build an
 * AuditEntry by hand. The sermon import preview in sermon-routes.ts is the one caller today.
 */
export function integrationCallAudit(
  trail: AuditTrail,
  actor: string,
  correlationId: string,
): (call: IntegrationCallInfo) => Promise<void> {
  return async (call) => {
    await trail.record(auditContext(actor, correlationId), {
      action: call.action,
      subject: call.subject,
      outcome: call.outcome,
      detail: call.detail,
      requestTokens: call.requestTokens,
      responseTokens: call.responseTokens,
      durationMs: call.durationMs,
    });
  };
}
