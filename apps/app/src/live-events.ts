// The vocabulary of what LIVE-04 calls "the four change classes" — current slide, Standby, theme, and
// run-state — and the one thing they share: reaching every authorized view as a `LiveHub.publish()` call,
// never as a poll a client had to make. This module knows nothing about how any of the four actually
// happens. `runs.ts` already causes run-state changes (`start`/`end` move a run's phase) and is wired
// below; a slide position mover and the Standby and theme domains are each a later task's own build
// (plan.md's T84/T85 and whichever task moves a run's position) — they reach every view the same way,
// through the one function this file exports for each class, once that domain exists to call it.
//
// A name here is the `type` an `EventFrame` carries on the wire (`live.ts`'s `NAME`: lower-case words
// joined by hyphens) — the whole of what LIVE-12's run-event log will have to group and search by, so
// each one says in a word what changed, not why.

import type { LiveHub, Landed } from './live-protocol.js';

export const LIVE_EVENT_TYPES = Object.freeze({
  slide: 'current-slide-changed',
  standby: 'standby-changed',
  theme: 'theme-changed',
  runState: 'run-state-changed',
  // Reserved for spec 07 and later tasks of this one (T84/T85 and the run engine); this task only adds
  // the type name, none of what causes it.
  mode: 'mode-changed',
  itemAdded: 'item-added',
  media: 'media-changed',
} as const);

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[keyof typeof LIVE_EVENT_TYPES];

/** The slide an Audience, Stage or Singer view is currently shown moved. */
export const publishSlideChanged = (hub: Pick<LiveHub, 'publish'>): Landed => hub.publish(LIVE_EVENT_TYPES.slide);

/** The Standby screen shown in place of a slide — or the choice of leaving it — moved. */
export const publishStandbyChanged = (hub: Pick<LiveHub, 'publish'>): Landed => hub.publish(LIVE_EVENT_TYPES.standby);

/** The theme a surface presents under moved. */
export const publishThemeChanged = (hub: Pick<LiveHub, 'publish'>): Landed => hub.publish(LIVE_EVENT_TYPES.theme);

/** A run's own lifecycle — `runs.ts`'s phase or mode — moved. */
export const publishRunStateChanged = (hub: Pick<LiveHub, 'publish'>): Landed => hub.publish(LIVE_EVENT_TYPES.runState);
