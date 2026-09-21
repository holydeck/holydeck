// Where a contracted announcement is actually said (AX-F3, raised at the DISC-02 accessibility
// measurement: every contracted announcement had an expected wording and none had a live region to say
// it in, so each of them was decorative). The UI contract's accessibility rule is one sentence —
// "Status announcements use `aria-live="polite"` for save, toast, and collaborator events; connection
// loss, expired invitation, and a newly introduced readiness blocker use an assertive announcement once,
// without repeated interruption" — and this module is that sentence as something that can fail.
//
// Three constructions carry it, rather than a comment asking people to remember it.
//
// *An announcement cannot be added without a region.* `ANNOUNCEMENTS` names the six the contract names,
// `POLITENESS_OF` is a total map over them, and `REGION_ID` is a total map over the politenesses. A
// seventh announcement is a compile error until it is graded, and a third politeness is a compile error
// until it has somewhere to be said. `createAnnouncer` then checks, against the real document, that each
// region exists and declares the `aria-live` the contract states — and throws rather than degrading, so a
// shell that lost a region fails at start-up instead of going quietly silent mid-service, which is
// exactly the failure AX-F3 found.
//
// *Assertive means once.* An assertive announcement interrupts whatever a listener was reading, which is
// why the contract permits it for three situations and bounds it at one interruption each. `announce`
// therefore refuses a second assertive announcement of the same kind — including one with different
// words — until `resolve` says the situation it was about has ended. What makes a repeat legitimate is a
// second occurrence, not a second render.
//
// *Nothing here writes copy.* A caller passes the sentence, in its own locale, the same separation
// `preparation-storage.ts` keeps between a code and the words for it. The one exception is
// `announceConnection` below, which owns the wording for the one announcement this module itself drives.
//
// Every element is reached through a narrow interface, the way `control.ts` reaches its own: this
// workspace's `lib` is ES2023 with no DOM, and a real element satisfies these two members anyway.

import { type Locale } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import type { LiveClient } from './live-client.js';

/** The six announcements the UI contract names, in the order it names them. */
export const ANNOUNCEMENTS = Object.freeze([
  'save',
  'toast',
  'collaborator',
  'connectionLoss',
  'expiredInvitation',
  'readinessBlocker',
] as const);

export type Announcement = (typeof ANNOUNCEMENTS)[number];

/** How much of an interruption an announcement is allowed to be. There is no third: `off` is not a
 *  politeness a contracted announcement can have, it is the absence of one. */
export const POLITENESS = Object.freeze(['polite', 'assertive'] as const);

export type Politeness = (typeof POLITENESS)[number];

/**
 * The contract's own grading. `save`, `toast` and `collaborator` are the ordinary traffic of a service
 * being prepared and are said politely; the other three are situations a person has to act on — a room
 * that is no longer following, a door that will not open, a service that cannot go live — and are the
 * only three the contract allows to interrupt.
 */
export const POLITENESS_OF: Readonly<Record<Announcement, Politeness>> = Object.freeze({
  save: 'polite',
  toast: 'polite',
  collaborator: 'polite',
  connectionLoss: 'assertive',
  expiredInvitation: 'assertive',
  readinessBlocker: 'assertive',
});

/**
 * Where each politeness is said, by the identifier the served document declares it under.
 *
 * One region per politeness rather than one per announcement, because a live region is a place a
 * screen reader watches, not a message: two assertive regions would mean two watched places racing to
 * interrupt with different halves of the same situation.
 */
export const REGION_ID: Readonly<Record<Politeness, string>> = Object.freeze({
  polite: 'announce-polite',
  assertive: 'announce-assertive',
});

/** Raised rather than returned: a shell that cannot say an announcement is a defect, not a value. */
export class AnnouncementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnouncementError';
  }
}

/** The two members this module touches on a region. Both are standard on any real element. */
export interface AnnouncementElementLike {
  textContent: string | null;
  getAttribute(name: string): string | null;
}

export interface AnnouncementDocumentLike {
  getElementById(id: string): AnnouncementElementLike | null;
}

export interface Announcer {
  /**
   * Says one announcement, in the words the caller chose. Answers whether it was said: an assertive
   * announcement already standing is refused rather than repeated, and a caller that renders on every
   * status change can therefore call this freely without interrupting a room twice.
   */
  announce(announcement: Announcement, message: string): boolean;
  /** Says the situation an assertive announcement was about has ended, so a later one speaks again. */
  resolve(announcement: Announcement): void;
  /** Whether an assertive announcement is currently standing. Never true of a polite one. */
  standing(announcement: Announcement): boolean;
}

/**
 * Binds the announcer to a document's live regions, checking each of them first.
 *
 * The check is the point. A region that is missing, or that declares a politeness other than the one the
 * contract states, would not announce what it was given — and nothing downstream would ever notice,
 * because writing text into an element succeeds whether or not anyone hears it.
 */
export function createAnnouncer(doc: AnnouncementDocumentLike): Announcer {
  const regions = new Map<Politeness, AnnouncementElementLike>();
  for (const politeness of POLITENESS) {
    const id = REGION_ID[politeness];
    const element = doc.getElementById(id);
    if (element === null) {
      throw new AnnouncementError(`the shell has no #${id}, so a ${politeness} announcement would go unsaid`);
    }
    const declared = element.getAttribute('aria-live');
    if (declared !== politeness) {
      throw new AnnouncementError(`#${id} must declare aria-live="${politeness}", not ${JSON.stringify(declared)}`);
    }
    regions.set(politeness, element);
  }

  const standing = new Set<Announcement>();
  /** Which announcement each region is currently showing, so resolving one never wipes another. */
  const showing = new Map<Politeness, Announcement>();

  const regionFor = (politeness: Politeness): AnnouncementElementLike =>
    regions.get(politeness) as AnnouncementElementLike;

  const say = (announcement: Announcement, politeness: Politeness, message: string): void => {
    const region = regionFor(politeness);
    // Identical text written over identical text is not a change, and a live region announces changes.
    // Cleared first so a second save is said as loudly as the first rather than swallowed.
    if (region.textContent === message) region.textContent = '';
    region.textContent = message;
    showing.set(politeness, announcement);
  };

  return {
    announce(announcement: Announcement, message: string): boolean {
      const politeness = POLITENESS_OF[announcement] as Politeness | undefined;
      // A name that is not one of the six would otherwise be written into whichever region `undefined`
      // happened to reach, which is no region at all: said nowhere, reported as said.
      if (politeness === undefined) throw new AnnouncementError(`there is no announcement named ${announcement}`);
      if (politeness === 'assertive') {
        if (standing.has(announcement)) return false;
        standing.add(announcement);
      }
      say(announcement, politeness, message);
      return true;
    },

    resolve(announcement: Announcement): void {
      if (!standing.delete(announcement)) return;
      const politeness = POLITENESS_OF[announcement];
      // Only cleared where this announcement is still the one showing: a second assertive situation may
      // have taken the region since, and that one has not ended.
      if (showing.get(politeness) !== announcement) return;
      regionFor(politeness).textContent = '';
      showing.delete(politeness);
    },

    standing: (announcement: Announcement): boolean => standing.has(announcement),
  };
}

/** The one thing this module reads off a live context, narrowed the way `reconnect-reconciliation.ts`
 *  narrows its own: `command`, `connect` and `close` are unnamed here, not merely unused. */
export type AnnouncingLiveClient = Pick<LiveClient, 'onStatus'>;

/**
 * Says the contract's connection-loss announcement off a real live session, and takes it back when the
 * session returns. This is the UI half of the event `reconnect-reconciliation.ts` handles the data half
 * of, and it is wired to `onStatus` rather than to a caller's own idea of connectivity so that the
 * announcement cannot drift from what the socket is actually doing.
 *
 * Which of the contract's two wordings is used is decided by `LiveFailure.recoverable`, because that is
 * the distinction a listener can act on: a recoverable drop is coming back on its own and the last
 * public frame stays up meanwhile, and an unrecoverable one is not, so editing stops and what was typed
 * is held. `LiveFailure.message` is never shown — it is diagnostic, English, and sometimes written by
 * the server verbatim.
 *
 * Every state in between — `authorizing`, `connecting`, `resuming` — is deliberately silent. A client
 * retrying clears its failure while it tries and sets it again when the attempt fails, and announcing
 * each of those would be the repeated interruption the contract forbids.
 */
export function announceConnection(
  live: AnnouncingLiveClient,
  announcer: Announcer,
  locale: Locale,
): () => void {
  return live.onStatus((status) => {
    if (status.state === 'synchronised') {
      // Nothing to take back, so nothing to confirm: a session that was never lost has not come back.
      if (!announcer.standing('connectionLoss')) return;
      announcer.resolve('connectionLoss');
      // Politely: coming back is a temporary confirmation, which is the layer the contract files a
      // toast under, and interrupting a room to say that everything is fine is the wrong trade.
      announcer.announce('toast', translate(locale, 'announce.connection.restored'));
      return;
    }
    const { failure } = status;
    if (failure === undefined) return;
    // A frame this client could not read leaves the session where it was and is not a lost connection.
    if (status.state !== 'degraded' && status.state !== 'closed') return;
    announcer.announce(
      'connectionLoss',
      translate(locale, failure.recoverable ? 'announce.connection.reconnecting' : 'announce.connection.lost'),
    );
  });
}
