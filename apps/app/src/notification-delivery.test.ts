import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPOSITORY = new URL('../../../', import.meta.url);

/** Every source file under a directory, including the ones in directories under it — `cli/commands`,
 *  `corpus/routes` and the two `internal` folders are as much of this repository as its flat trees. */
const sourcesUnder = (directory: string): readonly { name: string; text: string }[] => {
  const root = new URL(directory, import.meta.url);
  const found: { name: string; text: string }[] = [];
  const walk = (at: URL): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, at));
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const file = new URL(entry.name, at);
      found.push({
        name: relative(fileURLToPath(REPOSITORY), fileURLToPath(file)),
        text: readFileSync(file, 'utf8'),
      });
    }
  };
  walk(root);
  return found;
};

/** Every workspace in this repository, named rather than globbed: a glob would also walk the build and
 *  coverage output beside them, and a policy that passes because it read `dist` proves nothing. */
const WORKSPACES = [
  '../',
  '../../cli/',
  '../../corpus/',
  '../../web/',
  '../../worker/',
  '../../../packages/contracts/',
  '../../../packages/core/',
  '../../../packages/localization/',
  '../../../packages/renderer/',
];

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

  // Every workspace, not only the two that hold a notification today. The worker is where a delivery
  // job would naturally be put — it is the one process in this repository already running work nobody
  // is waiting on — so a scan that skipped it would be looking everywhere except the likely place.
  test('no module in any workspace carries a transport a notification could leave on', () => {
    // This file excepted, since it is the one place the names below are written down on purpose.
    const sources = WORKSPACES.flatMap((workspace) => sourcesUnder(`${workspace}src/`)).filter(
      ({ name }) => !name.endsWith('notification-delivery.test.ts'),
    );
    // A glob that silently matched nothing would make everything below pass without reading a line.
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.some(({ name }) => name.startsWith('apps/worker/src/'))).toBe(true);
    expect(sources.some(({ name }) => name.startsWith('packages/'))).toBe(true);
    const found = sources.flatMap(({ name, text }) =>
      TRANSPORTS.filter((transport) => text.includes(transport)).map((transport) => `${name}: ${transport}`),
    );
    expect(found).toEqual([]);
  });

  test('no workspace depends on one either, so none could be reached without being added first', () => {
    for (const workspace of WORKSPACES) {
      const manifest = new URL(`${workspace}package.json`, import.meta.url);
      const packaged = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      const names = Object.keys(packaged.dependencies ?? {}).join(' ').toLowerCase();
      for (const transport of TRANSPORTS) {
        expect(names, `${String(packaged.name)} depends on ${transport}`).not.toContain(transport.toLowerCase());
      }
    }
  });

  // Consumers remain confined to derivation, delivery policy and the in-app inbox.
  test('only the derivation, policy and in-app inbox consume notifications', () => {
    const consumers = WORKSPACES.flatMap((workspace) => sourcesUnder(`${workspace}src/`))
      .filter(({ text }) => text.includes("/notifications.js'"))
      .map(({ name }) => name)
      .sort();
    expect(consumers).toEqual([
      'apps/app/src/notification-delivery.test.ts',
      'apps/app/src/notification-delivery.ts',
      'apps/app/src/notification-routes.ts',
      'apps/app/src/notification-store.test.ts',
      'apps/app/src/notification-store.ts',
      'apps/app/src/notifications.test.ts',
      'packages/contracts/src/notifications.test.ts',
    ]);
  });

  test('this policy itself names no transport and opens nothing', () => {
    const text = readFileSync(new URL('./notification-delivery.ts', import.meta.url), 'utf8');
    for (const forbidden of ['fetch(', 'request(', 'node:http', 'node:net', 'node:dgram']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
