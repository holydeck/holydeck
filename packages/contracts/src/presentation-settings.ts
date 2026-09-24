// The presentation settings a deployment configures once, for every service it runs (OUT-03). Kept
// separate from `services.ts` (per-service output shape) and `accounts.ts` (per-account preference):
// this is neither — one instance-wide setting, admin-facing, with its own settings admin route.
//
// `TRANSITIONS` mirrors `apps/web/src/presentation-transitions.ts`'s own list of the same name, as a
// separate value literal rather than an import: this package is depended on by the server as well as
// the web app, and a package apps depend on must never import from an app in turn. The two lists are
// compared directly in this file's own test, so the two drifting apart is caught rather than silent,
// until a later Web task refactors that module to import `TransitionName` from here instead.

import { type Parsed, parseObject } from './problems.js';

export const TRANSITIONS = ['none', 'fade', 'crossfade', 'push'] as const;

export type TransitionName = (typeof TRANSITIONS)[number];

/** The hard cut every deployment can afford, and what an instance runs with until an admin picks another. */
export const DEFAULT_TRANSITION: TransitionName = 'none';

export interface PresentationSettings {
  readonly transition: TransitionName;
}

export function parsePresentationSettings(value: unknown): Parsed<PresentationSettings> {
  return parseObject(value, 'presentation', (reader) => ({
    transition: reader.choice('transition', TRANSITIONS),
  }));
}
