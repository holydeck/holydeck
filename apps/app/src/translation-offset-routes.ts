// Where every configured translation offset is read back, and where one is set (spec BIBL-02).
//
// Shaped like capability-routes.ts: the store's own presence gates every route with the same 404 stub,
// independently of whether this deployment also keeps an identity to audit a change against — writing the
// trail is best-effort here, exactly as issuing or revoking a capability is. Reading is public, the same
// as the corpus-browsing routes app.ts serves directly: BIBL-02 calls an offset "inspectable", and there is
// nothing in one worth a session. Setting one is a write, and is Admin's alone, behind the same permission
// the settings file and a Slide Layout are administered behind.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { type Parsed, parseObject } from '@holydeck/contracts/problems';
import { TRANSLATION_OFFSETS_PATH, TRANSLATION_OFFSET_BOUND } from '@holydeck/contracts/translation-offsets';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { SETTINGS_MANAGE } from './roles.js';
import { TranslationOffsetError, translationOffsetSystemContext } from './translation-offsets.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const TRANSLATION_OFFSET_PREFIX = 'translationOffset:';

const SET_PATH = `${TRANSLATION_OFFSETS_PATH}/:abbr`;

const PUBLIC: RouteNeed = { kind: 'public' };
const PERMISSION: RouteNeed = { kind: 'permission', need: SETTINGS_MANAGE };

/** Every route this module serves, in the order it registers them, and what each of them needs. */
const ROUTES = [
  { method: 'GET', url: TRANSLATION_OFFSETS_PATH, need: PUBLIC },
  { method: 'PUT', url: SET_PATH, need: PERMISSION },
] as const;

interface SetOffsetBody {
  readonly offset: number;
}

const parseSetOffsetBody = (value: unknown): Parsed<SetOffsetBody> =>
  parseObject(value, 'translationOffset', (reader) => ({ offset: reader.wholeNumber('offset', -TRANSLATION_OFFSET_BOUND) }));

export interface TranslationOffsetRoutesOptions {
  /** Absent in a deployment that keeps no translation offsets, which has none to read or configure. */
  readonly translationOffsets: TranslationOffsetStore | undefined;
  /** Absent audit-writing is best-effort everywhere else in this server, and this surface is no different. */
  readonly identity: Identity | undefined;
}

export function serveTranslationOffsetRoutes(
  app: FastifyInstance,
  { translationOffsets, identity }: TranslationOffsetRoutesOptions,
): void {
  // A deployment with nowhere to keep an offset has nothing here to read or set. Every path is still
  // served, at the same need it would otherwise be gated by, so the guard's table is unchanged either way.
  if (translationOffsets === undefined) {
    for (const { method, url, need } of ROUTES) {
      app.route({ method, url, config: { need }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const note = async (
    request: FastifyRequest,
    actor: string,
    outcome: AuditOutcome,
    subject: string,
    detail: string,
  ): Promise<void> => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(auditContext(actor, correlationFor(TRANSLATION_OFFSET_PREFIX, request.id)), {
        action: 'content.change',
        subject,
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the translation-offset trail refused an entry');
    }
  };

  app.get(TRANSLATION_OFFSETS_PATH, { config: { need: PUBLIC } }, async (request) => {
    const offsets = await translationOffsets.list();
    return successEnvelope({ offsets }, request.id, CLIENT_WINDOW.current);
  });

  app.put(SET_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { abbr } = request.params as { readonly abbr: string };
    const parsed = parseSetOffsetBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const operator = provenSession(request).record.actor;
    const call = translationOffsetSystemContext(correlationFor(TRANSLATION_OFFSET_PREFIX, request.id));
    try {
      const entry = await translationOffsets.set(call, abbr, parsed.value.offset);
      await note(request, operator, 'allowed', `translationOffset:${entry.abbr}`, `the offset was set to ${entry.offset}`);
      return reply.send(successEnvelope({ offset: entry }, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      if (error instanceof TranslationOffsetError && error.kind === 'schema') {
        return reply
          .code(422)
          .send(validationFailure(request.id, [{ path: 'abbr', code: VALIDATION_FAILED, message: error.message }]));
      }
      throw error;
    }
  });
}
