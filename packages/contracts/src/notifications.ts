import { FIELD_CODES, type FieldReader, type Parsed, parseObject } from './problems.js';

export const NOTIFICATION_CHANNELS = ['inApp', 'email', 'webhook'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_SEVERITIES = ['notice', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_CATEGORIES = [
  'authentication', 'authorization', 'settings', 'content', 'presentation', 'backup', 'restore', 'integration',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface ChannelPreferenceInput {
  readonly channel: NotificationChannel;
  readonly categories: readonly NotificationCategory[];
  readonly minimumSeverity: NotificationSeverity;
}

export interface NotificationPreferenceInput {
  readonly muted: boolean;
  readonly ownActions?: boolean;
  readonly channels: readonly ChannelPreferenceInput[];
}

const readCategories = (reader: FieldReader): readonly NotificationCategory[] => {
  const raw = reader.textList('categories');
  const categories: NotificationCategory[] = [];
  for (const [index, value] of raw.entries()) {
    const found = NOTIFICATION_CATEGORIES.find((candidate) => candidate === value);
    if (found === undefined) {
      reader.reject(`categories.${index}`, FIELD_CODES.notAllowed, `must be one of ${NOTIFICATION_CATEGORIES.join(', ')}`);
    } else if (categories.includes(found)) {
      reader.reject(`categories.${index}`, FIELD_CODES.notAllowed, `${found} is selected more than once`);
    } else {
      categories.push(found);
    }
  }
  return categories;
};

const parseChannelPreference = (value: unknown, path: string): Parsed<ChannelPreferenceInput> =>
  parseObject(value, path, (reader) => ({
    channel: reader.choice('channel', NOTIFICATION_CHANNELS),
    categories: readCategories(reader),
    minimumSeverity: reader.choice('minimumSeverity', NOTIFICATION_SEVERITIES),
  }));

export function parseNotificationPreferences(value: unknown): Parsed<NotificationPreferenceInput> {
  return parseObject(value, 'notification-preferences', (reader) => ({
    muted: reader.flag('muted'),
    ownActions: reader.optionalFlag('ownActions'),
    channels: reader.parsedList('channels', parseChannelPreference),
  }));
}
