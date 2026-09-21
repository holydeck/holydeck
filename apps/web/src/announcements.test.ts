import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  ANNOUNCEMENTS,
  AnnouncementError,
  POLITENESS,
  POLITENESS_OF,
  REGION_ID,
  type Announcement,
  type AnnouncementDocumentLike,
  type AnnouncementElementLike,
  type Politeness,
  announceConnection,
  createAnnouncer,
} from './announcements.js';

import type { LiveStatus } from './live-client.js';

/** One region, recording every write rather than only the last: a live region says nothing about a
 *  value that did not change, so what was written matters as much as what stands there now. */
class FakeRegion implements AnnouncementElementLike {
  readonly writes: string[] = [];

  #text: string | null = null;

  constructor(private readonly attributes: Readonly<Record<string, string>>) {}

  get textContent(): string | null {
    return this.#text;
  }

  set textContent(value: string | null) {
    this.#text = value;
    this.writes.push(value ?? '');
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

const shell = (
  overrides: Readonly<Record<string, FakeRegion | null>> = {},
): { doc: AnnouncementDocumentLike; regions: Record<Politeness, FakeRegion> } => {
  const regions = {
    polite: new FakeRegion({ 'aria-live': 'polite' }),
    assertive: new FakeRegion({ 'aria-live': 'assertive' }),
  };
  const byId: Record<string, FakeRegion | null> = {
    [REGION_ID.polite]: regions.polite,
    [REGION_ID.assertive]: regions.assertive,
    ...overrides,
  };
  return { doc: { getElementById: (id: string) => byId[id] ?? null }, regions };
};

const statusOf = (over: Partial<LiveStatus>): LiveStatus =>
  Object.freeze({ state: 'closed', stateRevision: 0, sequence: 0, ...over });

/** A live context reduced to the one thing this module reads off it, driven by hand. */
const fakeLive = (): { onStatus: (listener: (status: LiveStatus) => void) => () => void; emit: (status: LiveStatus) => void } => {
  const listeners = new Set<(status: LiveStatus) => void>();
  return {
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (status) => {
      for (const listener of [...listeners]) listener(status);
    },
  };
};

describe('the announcements the UI contract names', () => {
  test('names six, and grades each of them polite or assertive exactly as the contract does', () => {
    expect([...ANNOUNCEMENTS]).toEqual([
      'save',
      'toast',
      'collaborator',
      'connectionLoss',
      'expiredInvitation',
      'readinessBlocker',
    ]);
    expect(POLITENESS_OF).toEqual({
      save: 'polite',
      toast: 'polite',
      collaborator: 'polite',
      connectionLoss: 'assertive',
      expiredInvitation: 'assertive',
      readinessBlocker: 'assertive',
    });
  });

  test('gives every announcement a region, so none of them can be added without one', () => {
    for (const announcement of ANNOUNCEMENTS) {
      expect(POLITENESS).toContain(POLITENESS_OF[announcement]);
      expect(REGION_ID[POLITENESS_OF[announcement]]).toBeTruthy();
    }
    expect(Object.keys(POLITENESS_OF).sort()).toEqual([...ANNOUNCEMENTS].sort());
  });

  // AX-F3 itself: every contracted announcement had an expected wording and none had a live region to
  // say it in. This reads the served document rather than a fixture of it.
  test('the served shell carries a live region for each, at the politeness the contract states', () => {
    const html = readFileSync(new URL('./static/index.html', import.meta.url), 'utf8');
    for (const announcement of ANNOUNCEMENTS) {
      const politeness = POLITENESS_OF[announcement];
      const id = REGION_ID[politeness];
      const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`, 'u').exec(html);
      expect(tag, `the shell has no #${id} for a ${politeness} announcement`).not.toBeNull();
      expect(tag?.[0]).toContain(`aria-live="${politeness}"`);
    }
  });
});

describe('the announcer', () => {
  test('refuses a shell with no region to say an announcement in, rather than going silent', () => {
    expect(() => createAnnouncer(shell({ [REGION_ID.assertive]: null }).doc)).toThrow(AnnouncementError);
    expect(() => createAnnouncer(shell({ [REGION_ID.assertive]: null }).doc)).toThrow(REGION_ID.assertive);
  });

  test('refuses a region whose politeness is not the one the contract states', () => {
    const wrong = shell({ [REGION_ID.assertive]: new FakeRegion({ 'aria-live': 'polite' }) });
    expect(() => createAnnouncer(wrong.doc)).toThrow(/aria-live="assertive"/u);
  });

  test('refuses a region that declares no politeness at all', () => {
    const silent = shell({ [REGION_ID.polite]: new FakeRegion({}) });
    expect(() => createAnnouncer(silent.doc)).toThrow(AnnouncementError);
  });

  test('says save, toast and collaborator events politely', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    expect(announcer.announce('save', 'Saving')).toBe(true);
    expect(announcer.announce('toast', 'Checkpoint saved')).toBe(true);
    expect(announcer.announce('collaborator', 'Anna joined')).toBe(true);
    expect(regions.polite.writes).toEqual(['Saving', 'Checkpoint saved', 'Anna joined']);
    expect(regions.assertive.textContent).toBeNull();
  });

  test('clears a polite region before repeating itself, so a second save is said as loudly as the first', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    announcer.announce('save', 'Saving');
    announcer.announce('save', 'Saving');
    expect(regions.polite.writes).toEqual(['Saving', '', 'Saving']);
    expect(regions.polite.textContent).toBe('Saving');
  });

  test('says connection loss, an expired invitation and a readiness blocker assertively', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    announcer.announce('expiredInvitation', 'This invitation is unavailable');
    expect(regions.assertive.textContent).toBe('This invitation is unavailable');
    expect(regions.polite.textContent).toBeNull();
  });

  test('says an assertive announcement once and does not interrupt with it again', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    expect(announcer.announce('readinessBlocker', 'This service isn’t ready to present')).toBe(true);
    expect(announcer.announce('readinessBlocker', 'This service isn’t ready to present')).toBe(false);
    expect(announcer.announce('readinessBlocker', 'Something else entirely')).toBe(false);
    expect(regions.assertive.writes).toEqual(['This service isn’t ready to present']);
    expect(announcer.standing('readinessBlocker')).toBe(true);
  });

  test('says it again once the thing it was about is resolved, because that is a second occurrence', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    announcer.announce('connectionLoss', 'Connection lost');
    announcer.resolve('connectionLoss');
    expect(announcer.standing('connectionLoss')).toBe(false);
    expect(regions.assertive.textContent).toBe('');
    expect(announcer.announce('connectionLoss', 'Connection lost')).toBe(true);
    expect(regions.assertive.writes).toEqual(['Connection lost', '', 'Connection lost']);
  });

  test('resolving one assertive announcement never clears another one that is standing', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    announcer.announce('connectionLoss', 'Connection lost');
    announcer.announce('expiredInvitation', 'This invitation is unavailable');
    announcer.resolve('connectionLoss');
    expect(regions.assertive.textContent).toBe('This invitation is unavailable');
    expect(announcer.standing('expiredInvitation')).toBe(true);
  });

  test('resolving something that was never said, or a polite announcement, does nothing at all', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    announcer.announce('save', 'Saving');
    announcer.resolve('save');
    announcer.resolve('connectionLoss');
    expect(regions.polite.textContent).toBe('Saving');
    expect(announcer.standing('save')).toBe(false);
  });

  test('a polite announcement is never held back, however often it is repeated', () => {
    const { doc, regions } = shell();
    const announcer = createAnnouncer(doc);
    for (const message of ['Inserted', 'Moved', 'Duplicated']) {
      expect(announcer.announce('toast', message)).toBe(true);
    }
    expect(regions.polite.writes).toEqual(['Inserted', 'Moved', 'Duplicated']);
  });
});

describe('the assertive connection announcement, driven by a real live context', () => {
  test('says nothing at all while the session is coming up', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    live.emit(statusOf({ state: 'authorizing' }));
    live.emit(statusOf({ state: 'connecting' }));
    live.emit(statusOf({ state: 'synchronised' }));
    expect(regions.assertive.writes).toEqual([]);
    expect(regions.polite.writes).toEqual([]);
  });

  test('says a recoverable drop is being reconnected, once, however many retries follow', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    const dropped = statusOf({
      state: 'degraded',
      failure: { reason: 'closed', message: 'the live connection failed', code: 1006, recoverable: true },
    });
    live.emit(dropped);
    // What a real reconnect looks like: the client clears the failure while it tries again, and drops
    // back to degraded when the attempt fails. None of that is a second thing to interrupt a room with.
    live.emit(statusOf({ state: 'connecting' }));
    live.emit(dropped);
    expect(regions.assertive.writes).toEqual(['Reconnecting; last public frame remains visible']);
  });

  test('says a failure nothing will recover from is a loss, not a reconnection', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    live.emit(
      statusOf({
        state: 'closed',
        failure: { reason: 'unauthorized', message: 'could not prove itself', recoverable: false },
      }),
    );
    expect(regions.assertive.writes).toEqual(['Connection lost; editing is paused and typed text is safe']);
  });

  test('says it in the language the surface is running in', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'de');
    live.emit(
      statusOf({
        state: 'degraded',
        failure: { reason: 'closed', message: 'gone', code: 1006, recoverable: true },
      }),
    );
    expect(regions.assertive.writes[0]).toBe(
      'Verbindung wird wiederhergestellt; das letzte öffentliche Bild bleibt sichtbar',
    );
  });

  test('clears the loss and confirms politely once the session is actually back', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    const announcer = createAnnouncer(doc);
    announceConnection(live, announcer, 'en');
    live.emit(
      statusOf({ state: 'degraded', failure: { reason: 'closed', message: 'gone', code: 1006, recoverable: true } }),
    );
    live.emit(statusOf({ state: 'synchronised' }));
    expect(announcer.standing('connectionLoss')).toBe(false);
    expect(regions.assertive.textContent).toBe('');
    expect(regions.polite.writes).toEqual(['Back online. Checking for newer changes…']);
  });

  test('says the loss again after a second drop, because that is a second thing to have happened', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    const dropped = statusOf({
      state: 'degraded',
      failure: { reason: 'closed', message: 'gone', code: 1006, recoverable: true },
    });
    live.emit(dropped);
    live.emit(statusOf({ state: 'synchronised' }));
    live.emit(dropped);
    expect(regions.assertive.writes).toEqual([
      'Reconnecting; last public frame remains visible',
      '',
      'Reconnecting; last public frame remains visible',
    ]);
  });

  test('a frame it could not read is not a connection loss and is never announced as one', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    live.emit(
      statusOf({
        state: 'resuming',
        failure: { reason: 'unreadable-frame', message: 'kind: must be one of', recoverable: true },
      }),
    );
    expect(regions.assertive.writes).toEqual([]);
  });

  test('stops listening when the caller lets go of it', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    const stop = announceConnection(live, createAnnouncer(doc), 'en');
    stop();
    live.emit(
      statusOf({ state: 'degraded', failure: { reason: 'closed', message: 'gone', code: 1006, recoverable: true } }),
    );
    expect(regions.assertive.writes).toEqual([]);
  });

  test('a session that comes back without ever having been lost confirms nothing', () => {
    const { doc, regions } = shell();
    const live = fakeLive();
    announceConnection(live, createAnnouncer(doc), 'en');
    live.emit(statusOf({ state: 'synchronised' }));
    live.emit(statusOf({ state: 'synchronised' }));
    expect(regions.polite.writes).toEqual([]);
  });
});

describe('what the registry refuses to let drift', () => {
  test('every politeness the contract names has exactly one region, and no two share it', () => {
    const ids = POLITENESS.map((politeness) => REGION_ID[politeness]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(REGION_ID).sort()).toEqual([...POLITENESS].sort());
  });

  test('is frozen, so an announcement cannot quietly change politeness at run time', () => {
    expect(Object.isFrozen(ANNOUNCEMENTS)).toBe(true);
    expect(Object.isFrozen(POLITENESS_OF)).toBe(true);
    expect(Object.isFrozen(REGION_ID)).toBe(true);
  });

  test('the announcement names are what a caller may pass and nothing else', () => {
    const { doc } = shell();
    const announcer = createAnnouncer(doc);
    expect(() => announcer.announce('nothing-like-this' as Announcement, 'x')).toThrow(AnnouncementError);
  });
});
