// What the dashboard means by "next": not the soonest service ever scheduled, but the soonest one still
// ahead of today that somebody could still prepare or present. A completed or archived service never
// qualifies, even if its date has not yet rolled past — a duplicate dated ahead of itself, say.

import type { ServiceView } from './service-data.js';

const DONE_STATES = new Set(['completed', 'archived']);

/** The earliest upcoming, presentable service on or after `today`; a same-date tie is broken by title. */
export function nextService(list: readonly ServiceView[], today: string): ServiceView | undefined {
  const candidates = list.filter((service) => service.date >= today && !DONE_STATES.has(service.state));
  return candidates.reduce<ServiceView | undefined>((earliest, service) => {
    if (earliest === undefined) return service;
    if (service.date !== earliest.date) return service.date < earliest.date ? service : earliest;
    return service.title.localeCompare(earliest.title) < 0 ? service : earliest;
  }, undefined);
}
