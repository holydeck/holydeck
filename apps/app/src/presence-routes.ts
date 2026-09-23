// Where an editor says they are here, who else is, and that they have gone (spec v1c-09, COLAB-01).
//
// No audit trail: presence is operational state, not a change worth a permanent record, and
// `apps/app/src/presence.ts`'s own header says so plainly. No conflict handling either — the store
// never refuses a call for anything but a bad context, which is a fault, not something a caller
// corrects.
//
// Entering and listing ask what the content is before they answer (`content-kind.ts`): who is editing a
// Slide Layout is as much Admin's as the Layout is, and a member, who edits nothing, has no editor to be
// told about. Leaving asks nothing: it claims nothing and reveals nothing, and an editor whose permission
// was taken away mid-edit must still be able to say they have gone.
//
// A listing names each editor the way their account does, so a screen reads "Chioma Obi" rather than an
// account id. The name is looked up per read, never stored on the entry: an entry lives a minute, a
// rename should show on the next poll, and an actor without an account (or a store that cannot say) is
// simply left unnamed for the client to fall back on.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { accountIdIn } from '@holydeck/contracts/accounts';
import { parsePresenceEnter, type PresenceEntry } from '@holydeck/contracts/presence';

import { accountContext } from './accounts.js';
import { contentKindGate } from './content-kind.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { editorPresence } from './presence.js';
import { PRESENCE_USE } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { ContentKindOf } from './content-kind.js';
import type { Identity } from './onboarding.js';
import type { PresenceStore } from './presence.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const PRESENCE_PREFIX = 'presence:';

/** Who is editing this content, right now. */
export const PRESENCE_PATH = '/api/v1/presence/:contentId';

const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENCE_USE };

const ROUTES = [
  ['POST', PRESENCE_PATH],
  ['GET', PRESENCE_PATH],
  ['DELETE', PRESENCE_PATH],
] as const;

export interface PresenceRoutesOptions {
  /** Absent in a deployment with nowhere to keep an entry, which has none here to observe. */
  readonly presence: PresenceStore | undefined;
  /** Where refusals are recorded and editors' names are read. Without one, entries go unnamed. */
  readonly identity?: Identity | undefined;
  /** What a content id is, so its editors are shown only to a session that may edit it. */
  readonly kindOf?: ContentKindOf;
}

export function servePresenceRoutes(
  app: FastifyInstance,
  { presence, identity, kindOf }: PresenceRoutesOptions,
): void {
  if (presence === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request: FastifyRequest, reply: FastifyReply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  const store = presence;

  const call = (request: FastifyRequest) =>
    editorPresence(provenSession(request).record.actor, correlationFor(PRESENCE_PREFIX, request.id));

  const admitted = contentKindGate({ identity, kindOf, prefix: PRESENCE_PREFIX, what: 'presence' });

  /** The entry with its editor's account name beside it, or as it was when no account answers. */
  const named = async (request: FastifyRequest, entry: PresenceEntry): Promise<PresenceEntry> => {
    const id = accountIdIn(entry.actor);
    if (identity === undefined || id === undefined) return entry;
    try {
      const account = await identity.accounts.read(accountContext(correlationFor(PRESENCE_PREFIX, request.id)), id);
      return account === undefined ? entry : { ...entry, displayName: account.displayName };
    } catch (error: unknown) {
      request.log.warn({ err: error }, 'an editor could not be named');
      return entry;
    }
  };

  const contentIdOf = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const parsed = parsePresenceEnter(request.params, 'params');
    if (!parsed.ok) {
      reply.code(422).send(validationFailure(request.id, parsed.problems));
      return undefined;
    }
    return parsed.value.contentId;
  };

  app.post(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    if (!(await admitted(request, reply, contentId))) return reply;
    const entry = await store.enter(call(request), { contentId });
    return reply.send(successEnvelope(entry, request.id, CLIENT_WINDOW.current));
  });

  app.get(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    if (!(await admitted(request, reply, contentId))) return reply;
    const entries = await store.list(call(request), contentId);
    const listed = await Promise.all(entries.map((entry) => named(request, entry)));
    return reply.send(successEnvelope(listed, request.id, CLIENT_WINDOW.current));
  });

  app.delete(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    await store.leave(call(request), { contentId });
    return reply.code(204).send();
  });
}
