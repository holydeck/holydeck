import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';
import { ORDER_PATH } from '@holydeck/contracts/order';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { serviceContext } from './services.js';
import { slideLabelContext } from './slide-labels.js';

import type { RouteNeed } from './authorization.js';
import type { ServiceStore } from './services.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { FastifyInstance } from 'fastify';

const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };

export interface OrderRoutesOptions {
  readonly services: ServiceStore | undefined;
  readonly slideLabels: SlideLabelStore | undefined;
}

export function serveOrderRoutes(app: FastifyInstance, { services, slideLabels }: OrderRoutesOptions): void {
  if (services === undefined || slideLabels === undefined) {
    app.get(ORDER_PATH, { config: { need: PERMISSION } }, (request, reply) =>
      reply.code(404).send(notFound(request)),
    );
    return;
  }

  app.get(ORDER_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const operator = provenSession(request).record.actor;
    const correlationId = correlationFor('order:', request.id);
    const records = await services.list(serviceContext(operator, correlationId));
    // Only one service is expected to be presenting; if several are, the first wins.
    const presenting = records.find((service) => service.state === 'presenting');
    const items = (presenting?.sections ?? [])
      .flatMap((section) => section.items)
      .filter((item) => item.enabled)
      .map((item) => ({ id: item.id, label: item.title }));
    const catalogue = await slideLabels.catalogue(slideLabelContext(operator, correlationId));
    return reply.send(successEnvelope({ items, catalogue }, request.id, CLIENT_WINDOW.current));
  });
}
