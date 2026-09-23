// This session-gated route gives every client the output defaults it needs to compose a Service.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';
import { DEFAULT_SAFE_AREA_MARGINS } from '@holydeck/contracts/snapshots';

import { MEDIA_SIZE_CEILING_BYTES } from './media-routes.js';

import type { RouteNeed } from './authorization.js';
import type { FastifyInstance } from 'fastify';

/** The output settings a signed-in client may use when no Service override exists. */
export const OUTPUT_DEFAULTS_PATH = '/api/v1/output-defaults';

const SESSION: RouteNeed = { kind: 'session' };

/** Registers the authenticated output defaults route. */
export function serveOutputDefaultsRoutes(app: FastifyInstance): void {
  app.get(OUTPUT_DEFAULTS_PATH, { config: { need: SESSION } }, (request) =>
    successEnvelope({
      aspectRatio: '16:9', safeAreaMargins: DEFAULT_SAFE_AREA_MARGINS, uploadLimitBytes: MEDIA_SIZE_CEILING_BYTES,
    }, request.id, CLIENT_WINDOW.current),
  );
}
