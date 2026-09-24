import { beforeEach, describe, expect, it } from 'vitest';

import { notificationStoreOn } from './notification-store.js';
import { fakeNotificationDb } from '../test/helpers/fake-notification-db.js';

import type { NotificationStore } from './notification-store.js';
import type { Notification } from './notifications.js';

const NOW = '2026-09-23T12:00:00.000Z';
const row = (sourceEventId = 'event-1', recipient = 'A'): Notification => ({
  sourceEventId, recipient, at: '2026-09-22T12:00:00.000Z', channel: 'inApp', category: 'content',
  action: 'content.change', subject: 'song:1', outcome: 'allowed', severity: 'notice', correlationId: 'test-1',
});
let store: NotificationStore;
let instant: string;
beforeEach(() => {
  instant = NOW;
  store = notificationStoreOn(fakeNotificationDb(), { now: () => instant });
});

describe('the persisted inbox', () => {
  it('materializes only deliverable channels and preserves read and dismissed state on replay', async () => {
    const notifications = [row(), { ...row(), channel: 'email' as const }, { ...row(), channel: 'webhook' as const }];
    await store.materialize(notifications);
    await store.markRead('A', 'event-1:A:inApp');
    await store.markDismissed('A', 'event-1:A:inApp');
    await store.materialize(notifications);
    expect(await store.listFor('A')).toEqual([{
      _id: 'event-1:A:inApp', accountId: 'A', event: 'event-1', channel: 'inApp', category: 'content',
      action: 'content.change', subject: 'song:1', outcome: 'allowed', severity: 'notice', correlationId: 'test-1',
      createdAt: '2026-09-22T12:00:00.000Z', readAt: NOW, dismissedAt: NOW,
    }]);
  });

  it('lists newest first and filters unread rows for only the requested account', async () => {
    await store.materialize([row(), { ...row('event-2'), at: NOW }, row('event-3', 'B')]);
    expect((await store.listFor('A')).map((item) => item.event)).toEqual(['event-2', 'event-1']);
    await store.markRead('A', 'event-1:A:inApp');
    expect((await store.listFor('A', { unread: true })).map((item) => item.event)).toEqual(['event-2']);
  });

  it('excludes a dismissed-but-unread row from the unread list, but keeps it in the full list', async () => {
    await store.materialize([row(), row('event-2')]);
    await store.markDismissed('A', 'event-1:A:inApp');
    expect((await store.listFor('A', { unread: true })).map((item) => item.event)).toEqual(['event-2']);
    expect((await store.listFor('A')).map((item) => item.event)).toEqual(['event-1', 'event-2']);
  });

  it.each(['markRead', 'markDismissed'] as const)('%s refuses missing and foreign rows without changing them', async (method) => {
    await store.materialize([row()]);
    const before = await store.listFor('A');
    expect(await store[method]('B', 'event-1:A:inApp')).toBe(false);
    expect(await store[method]('A', 'missing')).toBe(false);
    expect(await store.listFor('A')).toEqual(before);
    expect(await store[method]('A', 'event-1:A:inApp')).toBe(true);
    expect(await store.listFor('A')).toMatchObject([{ [method === 'markRead' ? 'readAt' : 'dismissedAt']: NOW }]);
  });

  it('marks all own unread rows without changing other accounts or earlier read instants', async () => {
    await store.materialize([row(), row('event-2'), row('event-3', 'B')]);
    await store.markRead('A', 'event-1:A:inApp');
    instant = '2026-09-24T12:00:00.000Z';
    await store.markAllRead('A');
    expect((await store.listFor('A')).map((item) => item.readAt)).toEqual([NOW, instant]);
    expect((await store.listFor('B'))[0]?.readAt).toBeUndefined();
  });

  it('expires only rows read before the cutoff, preserving the boundary, recent and unread rows', async () => {
    await store.materialize([row('old'), row('boundary'), row('recent'), row('unread')]);
    instant = '2026-08-01T12:00:00.000Z';
    await store.markRead('A', 'old:A:inApp');
    instant = '2026-08-24T12:00:00.000Z';
    await store.markRead('A', 'boundary:A:inApp');
    instant = NOW;
    await store.markRead('A', 'recent:A:inApp');
    expect(await store.expireRead('2026-08-24T12:00:00.000Z')).toBe(1);
    expect((await store.listFor('A')).map((item) => item.event)).toEqual(['boundary', 'recent', 'unread']);
    expect(await store.expireRead('2026-08-24T12:00:00.000Z')).toBe(0);
  });

  it('defaults to every category in-app and saves preferences independently per account', async () => {
    expect(await store.preferencesFor('A')).toEqual({ recipient: 'A', muted: false, channels: [{
      channel: 'inApp', categories: ['authentication', 'authorization', 'settings', 'content', 'presentation', 'backup', 'restore', 'integration'],
      minimumSeverity: 'notice',
    }] });
    const preference = { recipient: 'A', muted: true, ownActions: true, channels: [] };
    await store.setPreferences('A', preference);
    expect(await store.preferencesFor('A')).toMatchObject(preference);
    expect((await store.preferencesFor('B')).muted).toBe(false);
  });

  it('keeps the derivation watermark separately for each account', async () => {
    expect(await store.watermarkFor('A')).toBeUndefined();
    await store.setWatermark('A', NOW);
    expect(await store.watermarkFor('A')).toBe(NOW);
    expect(await store.watermarkFor('B')).toBeUndefined();
    await store.setWatermark('A', '2026-09-24T12:00:00.000Z');
    expect(await store.watermarkFor('A')).toBe('2026-09-24T12:00:00.000Z');
  });
});
