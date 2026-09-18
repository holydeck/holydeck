// The operator's own scripture surface (spec BIBL-04): looking a reference up fast enough to use in the
// middle of a service, and — separately — showing one and recording what was shown.
//
// The split between those two is the point of this file. `app.ts` already serves a public
// `/translations/:abbr/verses` route, and it stays exactly as it is: not every read of a passage is
// somebody showing it, and a surface that recorded every read would fill the log with references nobody
// ever put in front of a room. So reading is one route here too, which records nothing and cannot, and
// showing is a second route that answers the same verses and writes exactly one entry. "A lookup never
// changes public output on its own" is that boundary and not a flag: the lookup handler below never
// touches the log at all, which is provable from this file rather than from a convention.
//
// What the log is, and is not, is spelled out in shown-references.ts's own header — it is a provisional
// stand-in for the presentation-run log T76-T79 build, not that log. The public output this feature will
// eventually drive does not exist yet either; when it does, showing a reference is what will drive it,
// and the route that does so is already the only one that records.
//
// Every route is Control presentation's, by the same permission capability-routes.ts gates issuing a
// guest invitation behind. There is no separate permission for a lookup: an operator who may run a
// presentation may read what they are about to show, and nobody else has a reason to reach this surface
// rather than the public one.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { type Parsed, parseObject } from '@holydeck/contracts/problems';

import { correlationFor } from './context.js';
import { REFERENCE_MALFORMED, referenceFrom, selectReference, versesIn } from './corpus.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { shownReferenceContext } from './shown-references.js';

import type { RouteNeed } from './authorization.js';
import type { CorpusRefusal, corpusClient } from './corpus.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const SHOWN_REFERENCE_PREFIX = 'shown:';

export const REFERENCE_LOOKUP_PATH = '/api/v1/live/reference-lookup';

export const SHOWN_REFERENCES_PATH = '/api/v1/live/shown-references';

const LOOKUP_PATH = `${REFERENCE_LOOKUP_PATH}/:abbr`;

/**
 * The interaction budget this surface is held to, end to end over the HTTP round trip — what an operator
 * waits for between typing a reference and seeing it, not what the library call costs on its own.
 *
 * Nothing enforces it at runtime, deliberately: a lookup that runs slow should still answer, because a
 * late verse is worth far more to a service than a refused one. It is asserted by this module's own test
 * instead, so a change that makes the operator path slow fails a build rather than a Sunday. The number
 * is this task's, provisional, and chosen for what this path actually is — an in-process read over corpus
 * data the deployment already holds. Confirming it on the supported matrix of real hardware is T111's job,
 * which owns every budget this product declares; this is the figure T111 has to confirm or correct.
 */
export const LOOKUP_BUDGET_MS = 150;

/** Every route this module serves, in the order it registers them. All three need the same permission. */
const ROUTES = [
  { method: 'GET', url: LOOKUP_PATH },
  { method: 'POST', url: SHOWN_REFERENCES_PATH },
  { method: 'GET', url: SHOWN_REFERENCES_PATH },
] as const;

const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };

interface ShowBody {
  readonly abbr: string;
  readonly book: string;
  readonly chapter: number;
  readonly verses: string;
  readonly revision: number | undefined;
}

// The verse list is read as text here and expanded by the same grammar the query string uses, so that the
// reference an operator shows is spelled exactly as the one they just looked up.
const parseShowBody = (value: unknown): Parsed<ShowBody> =>
  parseObject(value, 'shownReference', (reader) => ({
    abbr: reader.text('abbr'),
    book: reader.text('book'),
    chapter: reader.wholeNumber('chapter', 1),
    verses: reader.text('verses'),
    revision: reader.optionalWholeNumber('revision', 1),
  }));

export interface ReferenceRoutesOptions {
  /** The only way this application reads the library, handed in rather than built here. */
  readonly corpus: ReturnType<typeof corpusClient>;
  /** Absent in a deployment that keeps no record of what was shown, which may therefore show nothing. */
  readonly shownReferences: ShownReferenceStore | undefined;
}

const refused = (reply: FastifyReply, requestId: string, refusal: CorpusRefusal): FastifyReply =>
  reply.code(refusal.status).send(errorEnvelope(refusal.code, refusal.message, requestId));

export function serveReferenceRoutes(app: FastifyInstance, { corpus, shownReferences }: ReferenceRoutesOptions): void {
  // A deployment with nowhere to record what was shown may not show anything, because a display whose
  // revision went unrecorded is the one thing BIBL-04 rules out. The lookup path goes with it rather than
  // standing alone: it is the operator half of a surface that cannot work here, and the public verses
  // route already serves anybody who only wants to read. Every path is still served, at the need it would
  // otherwise be gated by, so the guard's table is the same shape in every deployment.
  if (shownReferences === undefined) {
    for (const { method, url } of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  // Reads the library and answers. It holds no reference to the log, which is what makes "a lookup never
  // shows anything on its own" a property of this code rather than a promise about it.
  app.get(LOOKUP_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { abbr } = request.params as { readonly abbr: string };
    const reference = referenceFrom(abbr, request.query as Record<string, unknown>);
    if (reference === undefined) return refused(reply, request.id, REFERENCE_MALFORMED);
    const answer = await selectReference(corpus, reference);
    if (!answer.ok) return refused(reply, request.id, answer.refusal);
    return reply.send(successEnvelope({ verses: answer.value }, request.id, CLIENT_WINDOW.current));
  });

  // The explicit show. Answers the same verses the lookup above does, and records the revision they were
  // actually read at — before replying, so that a log that refused the entry refuses the display too
  // rather than putting a passage in front of a room with nothing written down about it.
  app.post(SHOWN_REFERENCES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseShowBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const verses = versesIn(parsed.value.verses);
    if (verses === undefined) {
      return reply.code(422).send(
        validationFailure(request.id, [
          { path: 'shownReference.verses', code: VALIDATION_FAILED, message: 'must be verses such as 5,1-4' },
        ]),
      );
    }
    const { abbr, book, chapter, revision } = parsed.value;
    const answer = await selectReference(corpus, { abbr, book, chapter, verses, revision });
    // Nothing was shown, so nothing is recorded: the log holds what a room saw, not what was asked for.
    if (!answer.ok) return refused(reply, request.id, answer.refusal);
    const operator = provenSession(request).record.actor;
    const shown = await shownReferences.record(
      shownReferenceContext(operator, correlationFor(SHOWN_REFERENCE_PREFIX, request.id)),
      { reference: { abbr, book, chapter, verses }, revision: answer.value.revision },
    );
    return reply.code(201).send(successEnvelope({ verses: answer.value, shown }, request.id, CLIENT_WINDOW.current));
  });

  // Inspection, and the read-back BIBL-04's recording is worth anything only if it has: the most recently
  // shown first. Reading the log shows nothing and records nothing.
  app.get(SHOWN_REFERENCES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const operator = provenSession(request).record.actor;
    const shown = await shownReferences.recent(
      shownReferenceContext(operator, correlationFor(SHOWN_REFERENCE_PREFIX, request.id)),
    );
    return reply.send(successEnvelope({ shown }, request.id, CLIENT_WINDOW.current));
  });
}
