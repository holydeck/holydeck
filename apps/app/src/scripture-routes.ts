// Where a person searches the scripture this deployment already holds (spec BIBL-03) — the read half
// of the corpus surface, sibling to reference-routes.ts's lookup/show pair rather than a replacement for
// it: this route never touches the shown-references log, because finding a passage is not showing one.
//
// Gated wider than most of this file's siblings on purpose: an editor picking a verse for a slide and an
// operator picking one mid-service both search, and neither administers anything by doing so. `corpus` is
// never absent (app.ts always constructs one, even for an unconfigured deployment), so unlike every other
// route file in this spec there is no store-optional 404 fallback here.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { SCRIPTURE_SEARCH_PATH, parseScriptureSearchQuery } from '@holydeck/contracts/scripture';

import { searchScripture } from './corpus.js';
import { CONTENT_EDIT, PRESENTATION_CONTROL } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { CorpusRefusal, corpusClient } from './corpus.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const PERMISSION: RouteNeed = { kind: 'any-permission', needs: [CONTENT_EDIT, PRESENTATION_CONTROL] };

export interface ScriptureRoutesOptions {
  readonly corpus: ReturnType<typeof corpusClient>;
}

const refused = (reply: FastifyReply, requestId: string, refusal: CorpusRefusal): FastifyReply =>
  reply.code(refusal.status).send(errorEnvelope(refusal.code, refusal.message, requestId));

export function serveScriptureSearchRoutes(app: FastifyInstance, { corpus }: ScriptureRoutesOptions): void {
  app.get(SCRIPTURE_SEARCH_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseScriptureSearchQuery(request.query);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const result = await searchScripture(corpus, parsed.value.q);
    if (!result.ok) return refused(reply, request.id, result.refusal);
    return reply.send(successEnvelope(result.value, request.id, CLIENT_WINDOW.current));
  });
}
