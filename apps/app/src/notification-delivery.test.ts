import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  DELIVERABLE_CHANNELS,
  OUTBOUND_CHANNELS,
  deliverable,
  isDeliverable,
  withheld,
} from './notification-delivery.js';
import { NOTIFICATION_CHANNELS, notificationsFrom } from './notifications.js';

import type { NotifiableEvent, Notification, NotificationPreference } from './notifications.js';

const event = (over: Partial<NotifiableEvent> = {}): NotifiableEvent =>
  Object.freeze({
    id: 'entry-1',
    at: '2026-09-20T09:00:00.000Z',
    actor: 'account:someone-else',
    correlationId: 'settings:req-1',
    action: 'settings.update',
    subject: 'settings',
    outcome: 'allowed',
    ...over,
  });

/** One recipient who asked for everything, on every channel the model can name. */
const everything: NotificationPreference = Object.freeze({
  recipient: 'account:operator',
  muted: false,
  channels: NOTIFICATION_CHANNELS.map((channel) => ({
    channel,
    categories: ['settings'] as const,
    minimumSeverity: 'notice' as const,
  })),
});

const derived = (): readonly Notification[] => notificationsFrom([event()], [everything]);

const sourcesUnder = (directory: string): readonly { name: string; text: string }[] =>
  readdirSync(new URL(directory, import.meta.url))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(new URL(`${directory}${name}`, import.meta.url), 'utf8') }));

describe('notifications are in-app only in v1', () => {
  test('names exactly one deliverable channel, and it is the in-app one', () => {
    expect([...DELIVERABLE_CHANNELS]).toEqual(['inApp']);
  });

  test('grades every channel the model can name as deliverable or outbound, never both and never neither', () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(isDeliverable(channel)).toBe(!OUTBOUND_CHANNELS.includes(channel));
    }
    expect([...DELIVERABLE_CHANNELS, ...OUTBOUND_CHANNELS].sort()).toEqual([...NOTIFICATION_CHANNELS].sort());
  });

  test('names email and webhook as outbound, which is what v1 has no transport for', () => {
    expect([...OUTBOUND_CHANNELS].sort()).toEqual(['email', 'webhook']);
  });

  test('delivers only what the in-app channel carries, whatever a preference asked for', () => {
    const notifications = derived();
    expect(notifications.map((one) => one.channel).sort()).toEqual(['email', 'inApp', 'webhook']);
    expect(deliverable(notifications).map((one) => one.channel)).toEqual(['inApp']);
  });

  test('says what it withheld rather than dropping it quietly, so nothing is silently lost', () => {
    const notifications = derived();
    expect(withheld(notifications).map((one) => one.channel).sort()).toEqual(['email', 'webhook']);
    expect(deliverable(notifications).length + withheld(notifications).length).toBe(notifications.length);
  });

  test('changes nothing about the notification it passes through', () => {
    const notifications = derived();
    const [kept] = deliverable(notifications);
    expect(kept).toBe(notifications.find((one) => one.channel === 'inApp'));
  });

  test('answers nothing for nothing, on both halves', () => {
    expect(deliverable([])).toEqual([]);
    expect(withheld([])).toEqual([]);
  });

  test('is frozen, so the policy cannot be widened at run time', () => {
    expect(Object.isFrozen(DELIVERABLE_CHANNELS)).toBe(true);
    expect(Object.isFrozen(OUTBOUND_CHANNELS)).toBe(true);
  });
});

// The bullet this task exists for: in v1 there is no outbound channel. Asserted over the real source
// tree rather than over this module's own constants, because a constant saying "in-app only" is worth
// nothing next to a module that quietly opens a mail connection.
describe('no outbound channel exists in v1', () => {
  const TRANSPORTS = [
    'nodemailer',
    'createTransport',
    'sendMail',
    'sendmail',
    'smtp',
    'sendgrid',
    'mailgun',
    'postmark',
    'web-push',
    'webpush',
    'twilio',
    'apns',
    'webhookUrl',
    'webhookSecret',
  ];

  test('no module in either workspace carries a transport a notification could leave on', () => {
    // This file excepted, since it is the one place the names below are written down on purpose.
    const sources = [...sourcesUnder('./'), ...sourcesUnder('../../web/src/')].filter(
      ({ name }) => name !== 'notification-delivery.test.ts',
    );
    expect(sources.length).toBeGreaterThan(100);
    const found = sources.flatMap(({ name, text }) =>
      TRANSPORTS.filter((transport) => text.includes(transport)).map((transport) => `${name}: ${transport}`),
    );
    expect(found).toEqual([]);
  });

  test('no workspace depends on one either, so none could be reached without being added first', () => {
    const manifests = ['../package.json', '../../web/package.json', '../../../packages/contracts/package.json'];
    for (const manifest of manifests) {
      const packaged = JSON.parse(readFileSync(new URL(manifest, import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const names = Object.keys(packaged.dependencies ?? {}).join(' ').toLowerCase();
      for (const transport of TRANSPORTS) expect(names).not.toContain(transport.toLowerCase());
    }
  });

  // A notification nothing consumes cannot be delivered anywhere. The derivation and this policy are
  // the whole of what knows the type exists, which is what makes the claim above hold by construction
  // rather than by a denylist that a new dependency could step around.
  test('nothing outside the derivation and this policy consumes a notification at all', () => {
    const consumers = sourcesUnder('./')
      .filter(({ text }) => text.includes("from './notifications.js'"))
      .map(({ name }) => name)
      .sort();
    expect(consumers).toEqual(['notification-delivery.test.ts', 'notification-delivery.ts', 'notifications.test.ts']);
  });

  test('this policy itself names no transport and opens nothing', () => {
    const text = readFileSync(new URL('./notification-delivery.ts', import.meta.url), 'utf8');
    for (const forbidden of ['fetch(', 'request(', 'node:http', 'node:net', 'node:dgram']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
