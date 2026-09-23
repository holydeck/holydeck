import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { AUDIT_ACTIONS, AUDIT_CATEGORIES, CATEGORY_OF, auditContext, auditOn } from './audit.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PAGE_LIMIT,
  NOTIFICATION_SEVERITIES,
  SEVERITY_OF,
  deriveNotifications,
  notifiableEventOf,
  notificationsFrom,
  severityOf,
} from './notifications.js';
import { permissionsFor } from './records.js';
import { repositoriesOn } from './repositories.js';
import { requestContext } from './context.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type {
  ChannelPreference,
  NotifiableEvent,
  NotifiableEventReader,
  Notification,
  NotificationPreference,
} from './notifications.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const AT = '2026-09-21T09:00:00.000Z';
const CORRELATION = 'req-4a1f0c77';
const OPERATOR = 'account:operator';
const DEACON = 'account:deacon';

const at = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const event = (over: Partial<NotifiableEvent> = {}): NotifiableEvent => ({
  id: 'audit:e1',
  at: AT,
  actor: DEACON,
  correlationId: CORRELATION,
  action: 'settings.update',
  subject: 'settings',
  outcome: 'allowed',
  ...over,
});

const everything: ChannelPreference = {
  channel: 'inApp',
  categories: [...AUDIT_CATEGORIES],
  minimumSeverity: 'notice',
};

const prefers = (over: Partial<NotificationPreference> = {}): NotificationPreference => ({
  recipient: OPERATOR,
  muted: false,
  channels: [everything],
  ...over,
});

const readContext = () =>
  requestContext({ actor: 'system', permissions: [permissionsFor('auditEvents').read], correlationId: CORRELATION });

/** One stored trail row, as a reader hands it over. */
const trailRow = (id: string, when: string): Document => ({
  _id: id,
  actor: DEACON,
  correlationId: CORRELATION,
  at: when,
  action: 'settings.update',
  subject: 'settings',
  outcome: 'allowed',
});

const codesOf = (notifications: readonly Notification[]): string[] =>
  notifications.map((one) => `${one.recipient}/${one.channel}/${one.action}`);

/** A reader over a fake database that also counts every write method a caller might reach for. */
const readerOn = (db: FakeDb) => {
  const events = repositoriesOn(db).auditEvents;
  const append = vi.fn(events.append);
  // Deliberately wider than `NotifiableEventReader`: a reader carrying a write path still assigns to it,
  // which is what makes "this module never wrote" an observation rather than an assumption.
  const reader: NotifiableEventReader & { append: typeof append } = { read: events.read.bind(events), append };
  return { reader, append };
};

const recordOne = async (
  db: FakeDb,
  id: string,
  entry: { action: AuditAction; outcome: AuditOutcome; detail?: string },
  when: string,
) =>
  auditOn(db, { now: () => when, newId: () => id }).record(auditContext(DEACON, CORRELATION), {
    action: entry.action,
    subject: 'settings',
    outcome: entry.outcome,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });

describe('the vocabulary this module declares', () => {
  it('grades every category and outcome the trail can produce, so no action is unclassifiable', () => {
    for (const category of AUDIT_CATEGORIES) {
      for (const outcome of ['allowed', 'refused'] as const) {
        expect(NOTIFICATION_SEVERITIES).toContain(SEVERITY_OF[category][outcome]);
      }
    }
  });

  it('gives every declared audit action a severity through the trail’s own category map', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(NOTIFICATION_SEVERITIES).toContain(severityOf(event({ action })));
      expect(SEVERITY_OF[CATEGORY_OF[action]]).toBeDefined();
    }
  });

  it('reads a refusal as at least as serious as the same category allowed', () => {
    const rank = (severity: string): number => NOTIFICATION_SEVERITIES.indexOf(severity as never);
    for (const category of AUDIT_CATEGORIES) {
      expect(rank(SEVERITY_OF[category].refused)).toBeGreaterThanOrEqual(rank(SEVERITY_OF[category].allowed));
    }
  });
});

describe('what a notification is derived from', () => {
  it('carries the source event’s identity rather than a copy of what it said', () => {
    const [one] = notificationsFrom([event({ action: 'restore.run', subject: 'backup:19' })], [prefers()]);
    expect(one).toEqual({
      sourceEventId: 'audit:e1',
      at: AT,
      recipient: OPERATOR,
      channel: 'inApp',
      category: 'restore',
      action: 'restore.run',
      subject: 'backup:19',
      outcome: 'allowed',
      severity: SEVERITY_OF.restore.allowed,
      correlationId: CORRELATION,
    });
  });

  it('never repeats the trail’s free prose, which is what keeps the trail the one place it is written', async () => {
    const detail = 'restored from mongodb://root:hunter2@db.internal:27017';
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'restore.run', outcome: 'allowed', detail }, AT);
    // The trail really is holding it, so what follows is a statement about the derivation rather than
    // about a fixture that never carried the prose in the first place.
    expect(db.rows.get('audit_events')?.[0]).toMatchObject({ detail });

    const { reader } = readerOn(db);
    const derived = await deriveNotifications(reader, readContext(), [prefers()]);
    expect(derived.notifications).toHaveLength(1);
    expect(JSON.stringify(derived.notifications)).not.toContain('hunter2');
    expect(JSON.stringify(derived.notifications)).not.toContain(detail);
    expect(derived.notifications[0]).not.toHaveProperty('detail');
  });

  it('derives nothing at all from no events, whatever anybody asked to be told about', () => {
    expect(notificationsFrom([], [prefers(), prefers({ recipient: DEACON })])).toEqual([]);
  });

  it('tracks its input: two different event sets under one preference give two different results', () => {
    const preferences = [prefers()];
    const quiet = notificationsFrom([event({ id: 'audit:e1' })], preferences);
    const busy = notificationsFrom([event({ id: 'audit:e1' }), event({ id: 'audit:e2', at: at(1) })], preferences);
    expect(quiet.map((one) => one.sourceEventId)).toEqual(['audit:e1']);
    expect(busy.map((one) => one.sourceEventId)).toEqual(['audit:e1', 'audit:e2']);
  });

  it('sources every notification from an event it was handed, and invents none', () => {
    const events = [event({ id: 'audit:e1' }), event({ id: 'audit:e2', at: at(1) })];
    const ids = new Set(events.map((one) => one.id));
    for (const one of notificationsFrom(events, [prefers(), prefers({ recipient: 'account:third' })])) {
      expect(ids.has(one.sourceEventId)).toBe(true);
    }
  });

  it('orders by when the event happened, so a notification never precedes an earlier one', () => {
    const derived = notificationsFrom(
      [event({ id: 'audit:late', at: at(5) }), event({ id: 'audit:early', at: at(1) })],
      [prefers()],
    );
    expect(derived.map((one) => one.sourceEventId)).toEqual(['audit:early', 'audit:late']);
  });

  it('settles two entries sharing an instant by identifier, so one page derives one sequence', () => {
    const shared = [event({ id: 'audit:b' }), event({ id: 'audit:a' })];
    const forwards = notificationsFrom(shared, [prefers()]).map((one) => one.sourceEventId);
    const backwards = notificationsFrom([...shared].reverse(), [prefers()]).map((one) => one.sourceEventId);
    expect(forwards).toEqual(['audit:a', 'audit:b']);
    expect(backwards).toEqual(forwards);
  });

  it('orders rather than drops an event it was handed twice, because deduplication is the trail’s job', () => {
    const twice = [event({ id: 'audit:e1' }), event({ id: 'audit:e1' })];
    expect(notificationsFrom(twice, [prefers()]).map((one) => one.sourceEventId)).toEqual(['audit:e1', 'audit:e1']);
  });
});

describe('what counts as a source event at all', () => {
  const row: Document = {
    _id: 'audit:e1',
    actor: DEACON,
    correlationId: CORRELATION,
    at: AT,
    action: 'settings.update',
    subject: 'settings',
    outcome: 'allowed',
  };

  it('accepts a row the trail wrote, with the trail’s own identity fields', () => {
    expect(notifiableEventOf(row)).toEqual(event({ id: 'audit:e1' }));
  });

  it('refuses a document carrying no trail identity, so nothing unrecorded becomes notifiable', () => {
    for (const missing of ['_id', 'at', 'actor', 'correlationId', 'subject']) {
      expect(notifiableEventOf({ ...row, [missing]: undefined })).toBeUndefined();
    }
  });

  it('refuses an action the trail does not declare and an outcome it cannot have', () => {
    expect(notifiableEventOf({ ...row, action: 'notification.invent' })).toBeUndefined();
    expect(notifiableEventOf({ ...row, outcome: 'maybe' })).toBeUndefined();
  });
});

describe('user and channel preferences', () => {
  it('sends on every channel a preference names, and on no channel it does not', () => {
    const derived = notificationsFrom(
      [event()],
      [prefers({ channels: [everything, { ...everything, channel: 'email' }] })],
    );
    expect(derived.map((one) => one.channel)).toEqual(['inApp', 'email']);
    expect(NOTIFICATION_CHANNELS).toContain('webhook');
    expect(derived.map((one) => one.channel)).not.toContain('webhook');
  });

  it('carries only the categories a channel asked for', () => {
    const derived = notificationsFrom(
      [event({ id: 'audit:s', action: 'settings.update' }), event({ id: 'audit:c', at: at(1), action: 'content.change' })],
      [prefers({ channels: [{ ...everything, categories: ['content'] }] })],
    );
    expect(derived.map((one) => one.sourceEventId)).toEqual(['audit:c']);
  });

  it('holds back anything below the severity a channel is worth interrupting for', () => {
    const preferences = [prefers({ channels: [{ ...everything, minimumSeverity: 'critical' }] })];
    const derived = notificationsFrom(
      [
        event({ id: 'audit:notice', action: 'content.change' }),
        event({ id: 'audit:critical', at: at(1), action: 'authorization.refuse', outcome: 'refused' }),
      ],
      preferences,
    );
    expect(derived.map((one) => one.sourceEventId)).toEqual(['audit:critical']);
  });

  it('says nothing to a fully muted recipient, whatever their channels would otherwise carry', () => {
    const loud = [event({ action: 'authorization.refuse', outcome: 'refused' })];
    expect(notificationsFrom(loud, [prefers({ muted: true })])).toEqual([]);
    expect(
      notificationsFrom(loud, [
        prefers({ muted: true, channels: [everything, { ...everything, channel: 'email' }] }),
      ]),
    ).toEqual([]);
  });

  it('says nothing to a recipient who named no channel, and nothing on a channel carrying no category', () => {
    expect(notificationsFrom([event()], [prefers({ channels: [] })])).toEqual([]);
    expect(notificationsFrom([event()], [prefers({ channels: [{ ...everything, categories: [] }] })])).toEqual([]);
  });

  it('does not tell somebody about their own action unless they asked to hear it', () => {
    const own = [event({ actor: OPERATOR })];
    expect(notificationsFrom(own, [prefers()])).toEqual([]);
    expect(notificationsFrom(own, [prefers({ ownActions: true })])).toHaveLength(1);
  });

  it('sends one notification per channel even when a preference names the same channel twice', () => {
    const derived = notificationsFrom([event()], [prefers({ channels: [everything, everything] })]);
    expect(derived).toHaveLength(1);
  });

  it('answers each recipient on their own terms from the one event', () => {
    const derived = notificationsFrom(
      [event({ action: 'backup.run', outcome: 'refused' })],
      [
        prefers(),
        prefers({ recipient: 'account:pastor', channels: [{ ...everything, channel: 'email', categories: ['content'] }] }),
        prefers({ recipient: 'account:tech', muted: true }),
      ],
    );
    expect(codesOf(derived)).toEqual([`${OPERATOR}/inApp/backup.run`]);
  });
});

describe('reading the trail the notifications come from', () => {
  it('derives from what the trail holds and hands back the watermark the caller carries next', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    const { reader } = readerOn(db);
    const derived = await deriveNotifications(reader, readContext(), [prefers()]);
    expect(derived.notifications.map((one) => one.sourceEventId)).toEqual(['audit:e1']);
    expect(derived.watermark).toBe(AT);
    expect(derived.truncated).toBe(false);
  });

  it('skips what the caller has already been told about', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    await recordOne(db, 'e2', { action: 'settings.update', outcome: 'allowed' }, at(5));
    const { reader } = readerOn(db);
    const derived = await deriveNotifications(reader, readContext(), [prefers()], { since: AT });
    expect(derived.notifications.map((one) => one.sourceEventId)).toEqual(['audit:e2']);
    expect(derived.watermark).toBe(at(5));
  });

  it('advances the watermark over a page nobody asked to hear about', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'content.change', outcome: 'allowed' }, AT);
    const { reader } = readerOn(db);
    const derived = await deriveNotifications(reader, readContext(), [prefers({ muted: true })]);
    expect(derived.notifications).toEqual([]);
    expect(derived.watermark).toBe(AT);
  });

  it('offers no watermark from a first run that filled its page, having nothing to have reached back to', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    await recordOne(db, 'e2', { action: 'settings.update', outcome: 'allowed' }, at(5));
    const { reader } = readerOn(db);
    const derived = await deriveNotifications(reader, readContext(), [prefers()], { limit: 1 });
    expect(derived.truncated).toBe(true);
    expect(derived.watermark).toBeUndefined();
    expect(derived.notifications).toHaveLength(1);
  });

  // The trail is append-only and never shrinks, so within days of a deployment starting every page is a
  // full one. Reading fullness alone as "there is more" would withhold the watermark from then on and
  // leave a caller re-deriving — and a delivery surface re-delivering — the same page forever.
  it('keeps the watermark when a full page reached back over the caller’s own, however full it was', async () => {
    const rows = [trailRow('audit:new', at(10)), trailRow('audit:old', AT)];
    const derived = await deriveNotifications({ read: async () => rows }, readContext(), [prefers()], {
      since: AT,
      limit: rows.length,
    });
    expect(derived.truncated).toBe(false);
    expect(derived.watermark).toBe(at(10));
    expect(derived.notifications.map((one) => one.sourceEventId)).toEqual(['audit:new']);
  });

  it('withholds the watermark from a full page of entries the caller has all still to hear about', async () => {
    const rows = [trailRow('audit:newest', at(20)), trailRow('audit:newer', at(10))];
    const derived = await deriveNotifications({ read: async () => rows }, readContext(), [prefers()], {
      since: AT,
      limit: rows.length,
    });
    expect(derived.truncated).toBe(true);
    expect(derived.watermark).toBeUndefined();
  });

  it('reads a bounded page by default rather than the whole trail', async () => {
    const read = vi.fn(async () => [] as Document[]);
    await deriveNotifications({ read }, readContext(), [prefers()]);
    expect(read).toHaveBeenCalledWith(expect.anything(), {}, { limit: NOTIFICATION_PAGE_LIMIT, sort: { at: -1 } });
  });

  it('filters the trail by action when the caller narrows it', async () => {
    const read = vi.fn(async () => [] as Document[]);
    await deriveNotifications({ read }, readContext(), [prefers()], { actions: ['content.change'] });
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      { action: { $in: ['content.change'] } },
      { limit: NOTIFICATION_PAGE_LIMIT, sort: { at: -1 } },
    );
  });

  it('takes the watermark from the newest entry on the page, whatever order the store answered in', async () => {
    const rows = [trailRow('audit:new', at(5)), trailRow('audit:old', AT)];
    const derived = await deriveNotifications({ read: async () => rows }, readContext(), [prefers()]);
    expect(derived.watermark).toBe(at(5));
    expect(derived.notifications.map((one) => one.sourceEventId)).toEqual(['audit:old', 'audit:new']);
  });

  it('ignores a row the trail could not have written rather than notifying on it', async () => {
    const read = async (): Promise<Document[]> => [{ _id: 'forged', action: 'settings.update' }];
    const derived = await deriveNotifications({ read }, readContext(), [prefers()]);
    expect(derived.notifications).toEqual([]);
    expect(derived.watermark).toBeUndefined();
  });

  it('is refused the trail outright when the context may not read it', async () => {
    const db = fakeDb();
    const { reader } = readerOn(db);
    const blind = requestContext({ actor: 'system', permissions: [], correlationId: CORRELATION });
    await expect(deriveNotifications(reader, blind, [prefers()])).rejects.toThrow(/may not read/u);
  });
});

describe('the trail stays the source of truth (delivery rule 4)', () => {
  it('never writes while deriving, though the reader it was handed could', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    const { reader, append } = readerOn(db);
    const before = (db.rows.get('audit_events') ?? []).length;
    await deriveNotifications(reader, readContext(), [prefers()]);
    expect(append).not.toHaveBeenCalled();
    expect(db.rows.get('audit_events') ?? []).toHaveLength(before);
  });

  it('names no writer at all in its own source, so there is no path back into the trail', () => {
    const source = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8');
    for (const writer of ['auditOn', 'repositoriesOn', 'insertOne', '.append(', '.record(']) {
      expect(source.includes(writer)).toBe(false);
    }
  });

  it('cannot see an event the trail has not taken yet, and sees it once the trail has', async () => {
    const db = fakeDb();
    const { reader } = readerOn(db);
    const context = readContext();

    const beforeAnything = await deriveNotifications(reader, context, [prefers()]);
    expect(beforeAnything.notifications).toEqual([]);

    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    const afterFirst = await deriveNotifications(reader, context, [prefers()]);
    expect(afterFirst.notifications.map((one) => one.sourceEventId)).toEqual(['audit:e1']);

    // The second entry exists only after the trail took it: the derivation run in between saw one event,
    // and no ordering of these calls produces a notification whose source event was not already written.
    await recordOne(db, 'e2', { action: 'settings.update', outcome: 'allowed' }, at(5));
    const afterSecond = await deriveNotifications(reader, context, [prefers()]);
    expect(afterSecond.notifications.map((one) => one.sourceEventId)).toEqual(['audit:e1', 'audit:e2']);
  });

  it('dates every notification at its source event, never at the moment it was derived', async () => {
    const db = fakeDb();
    await recordOne(db, 'e1', { action: 'settings.update', outcome: 'allowed' }, AT);
    const { reader } = readerOn(db);
    const [one] = (await deriveNotifications(reader, readContext(), [prefers()])).notifications;
    const [row] = db.rows.get('audit_events') ?? [];
    expect(one?.at).toBe(row?.['at']);
    expect(one?.sourceEventId).toBe(row?.['_id']);
    expect(one?.correlationId).toBe(row?.['correlationId']);
  });
});
