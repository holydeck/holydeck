// OPER-03: which of the channels a recipient may ask for this version actually delivers on — and the
// answer for v1 is one of them, the one inside this product.
//
// `notifications.ts` derives what each person is owed on each channel they keep open, and deliberately
// delivers none of it. This is the other half: the policy that says what may leave, standing between the
// derivation and any future transport. It exists as a module rather than as a sentence in the release
// notes because a sentence cannot be a test, and the guarantee here is one an operator is entitled to
// have checked rather than promised.
//
// Why in-app only, and why it is a guarantee rather than a gap. Mail and webhooks are outbound: they
// carry what happened in this installation to a server somebody else runs, they need a credential this
// deployment would then hold, and they keep working after the person they were set up for has left. A
// congregation's trail includes who was refused, at what hour, from where — and the first version of
// this product is not the place to start posting that to an address nobody re-reads. In-app delivery has
// none of those properties: it reaches a person who is already signed in, it carries nothing off the
// machine, and it stops mattering the moment their account does.
//
// Two constructions hold it rather than describing it. `DELIVERABLE_CHANNELS` and `OUTBOUND_CHANNELS`
// partition `NOTIFICATION_CHANNELS` — a channel added to the model tomorrow is outbound until somebody
// deliberately moves it — and `deliverable`/`withheld` are total over that partition, so nothing is
// dropped silently: a caller can always ask what did not go out and why there was no way to send it.
//
// Nothing here opens anything. No socket, no client, no address, no credential: this module reads a
// channel name and answers a question about it. That is what makes the "no outbound channel exists"
// claim in the test beside it checkable against the whole source tree instead of against a promise.

import { NOTIFICATION_CHANNELS } from './notifications.js';

import type { Notification, NotificationChannel } from './notifications.js';

/** The channels this version delivers on. One, and it goes no further than a signed-in person's screen. */
export const DELIVERABLE_CHANNELS = Object.freeze(['inApp'] as const);

export type DeliverableChannel = (typeof DELIVERABLE_CHANNELS)[number];

const deliverableNames: readonly string[] = DELIVERABLE_CHANNELS;

/**
 * Every other channel the preference model can name: the ones that would carry something off this
 * machine, and that v1 has no transport for.
 *
 * Derived by subtraction rather than listed, so a channel added to `NOTIFICATION_CHANNELS` lands here on
 * its own. A new routing target that nobody remembered to consider is then withheld by default, which is
 * the safe direction for a list whose members send a congregation's audit trail somewhere else.
 */
export const OUTBOUND_CHANNELS: readonly NotificationChannel[] = Object.freeze(
  NOTIFICATION_CHANNELS.filter((channel) => !deliverableNames.includes(channel)),
);

/** Whether this version has any way at all of delivering on a channel. */
export const isDeliverable = (channel: NotificationChannel): channel is DeliverableChannel =>
  deliverableNames.includes(channel);

/**
 * The notifications this version can actually deliver.
 *
 * Every field is passed through untouched — the same frozen objects the derivation produced — because
 * this is a policy and not a second derivation: what a person is owed was already decided upstream, and
 * the only question here is whether there is a way to hand it to them.
 */
export function deliverable(notifications: readonly Notification[]): readonly Notification[] {
  return Object.freeze(notifications.filter((notification) => isDeliverable(notification.channel)));
}

/**
 * The other half: what a recipient asked for and this version has no way to send.
 *
 * Returned rather than discarded so the filtering above is observable. A surface can tell someone that
 * the mail they asked for is not something this version does — which is a different thing from their
 * notifications quietly never arriving, and the difference is the whole reason this half exists.
 */
export function withheld(notifications: readonly Notification[]): readonly Notification[] {
  return Object.freeze(notifications.filter((notification) => !isDeliverable(notification.channel)));
}
