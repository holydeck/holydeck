import { AUDIT_CATEGORIES } from './audit.js';
import { deliverable } from './notification-delivery.js';

import type { Db } from 'mongodb';

import type { AuditAction, AuditCategory, AuditOutcome } from './audit.js';
import type { Notification, NotificationChannel, NotificationPreference, NotificationSeverity } from './notifications.js';

export const NOTIFICATIONS_COLLECTION = 'notifications';
export const NOTIFICATION_PREFERENCES_COLLECTION = 'notification_preferences';
export const NOTIFICATION_WATERMARKS_COLLECTION = 'notification_watermarks';

export interface NotificationRow {
  readonly _id: string;
  readonly accountId: string;
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly category: AuditCategory;
  readonly action: AuditAction;
  readonly subject: string;
  readonly outcome: AuditOutcome;
  readonly severity: NotificationSeverity;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly dismissedAt?: string;
}

export interface ListOptions {
  readonly unread?: boolean;
}

export interface NotificationStore {
  listFor(accountId: string, options?: ListOptions): Promise<readonly NotificationRow[]>;
  markRead(accountId: string, id: string): Promise<boolean>;
  markAllRead(accountId: string): Promise<void>;
  markDismissed(accountId: string, id: string): Promise<boolean>;
  /** Physically deletes read rows older than `olderThan` (an ISO instant); answers how many. */
  expireRead(olderThan: string): Promise<number>;
  preferencesFor(accountId: string): Promise<NotificationPreference>;
  setPreferences(accountId: string, preference: NotificationPreference): Promise<void>;
  /** Bulk-upserts a derivation's notifications, skipping any that already exist (idempotent). */
  materialize(rows: readonly Notification[]): Promise<void>;
  watermarkFor(accountId: string): Promise<string | undefined>;
  setWatermark(accountId: string, watermark: string): Promise<void>;
}

interface Filter {
  readonly [key: string]: unknown;
}

interface ReadOptions {
  readonly sort?: Readonly<Record<string, 1 | -1>>;
  readonly limit?: number;
}

export interface NotificationCollection {
  countDocuments(filter: Filter): Promise<number>;
  findOne(filter: Filter): Promise<Record<string, unknown> | null>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Record<string, unknown>[]> };
  insertOne(document: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  findOneAndUpdate(
    filter: Filter,
    update: Record<string, unknown>,
    options: { readonly upsert: boolean; readonly returnDocument: 'after' },
  ): Promise<Record<string, unknown> | null>;
  updateOne(filter: Filter, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
  updateMany(filter: Filter, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface NotificationDb {
  collection(name: string): NotificationCollection;
}

export interface NotificationStoreOptions {
  readonly now: () => string;
}

const DEFAULT_PREFERENCE = (accountId: string): NotificationPreference =>
  Object.freeze({
    recipient: accountId,
    muted: false,
    channels: [
      Object.freeze({
        channel: 'inApp' as NotificationChannel,
        categories: [...AUDIT_CATEGORIES],
        minimumSeverity: 'notice' as const,
      }),
    ],
  });

function rowIdOf(notification: Notification): string {
  return `${notification.sourceEventId}:${notification.recipient}:${notification.channel}`;
}

export function notificationStoreOn(db: NotificationDb, options: NotificationStoreOptions): NotificationStore {
  const rows = () => db.collection(NOTIFICATIONS_COLLECTION);
  const preferences = () => db.collection(NOTIFICATION_PREFERENCES_COLLECTION);
  const watermarks = () => db.collection(NOTIFICATION_WATERMARKS_COLLECTION);

  const store: NotificationStore = {
    async listFor(accountId, options2 = {}) {
      const filter: Filter = options2.unread === true ? { accountId, readAt: { $exists: false } } : { accountId };
      const found = await rows().find(filter, { sort: { createdAt: -1 } }).toArray();
      return found as unknown as readonly NotificationRow[];
    },

    async markRead(accountId, id) {
      const { matchedCount } = await rows().updateOne(
        { _id: id, accountId },
        { $set: { readAt: options.now() } },
      );
      return matchedCount > 0;
    },

    async markAllRead(accountId) {
      await rows().updateMany({ accountId, readAt: { $exists: false } }, { $set: { readAt: options.now() } });
    },

    async markDismissed(accountId, id) {
      const { matchedCount } = await rows().updateOne(
        { _id: id, accountId },
        { $set: { dismissedAt: options.now() } },
      );
      return matchedCount > 0;
    },

    async expireRead(olderThan) {
      const { deletedCount } = await rows().deleteMany({ readAt: { $lt: olderThan } });
      return deletedCount;
    },

    async preferencesFor(accountId) {
      const found = await preferences().findOne({ _id: accountId });
      if (found === null) return DEFAULT_PREFERENCE(accountId);
      return found as unknown as NotificationPreference;
    },

    async setPreferences(accountId, preference) {
      await preferences().findOneAndUpdate(
        { _id: accountId },
        { $set: { ...preference, _id: accountId } },
        { upsert: true, returnDocument: 'after' },
      );
    },

    async materialize(notifications) {
      for (const notification of deliverable(notifications)) {
        const id = rowIdOf(notification);
        await rows().findOneAndUpdate(
          { _id: id },
          {
            $setOnInsert: {
              _id: id,
              accountId: notification.recipient,
              event: notification.sourceEventId,
              channel: notification.channel,
              category: notification.category,
              action: notification.action,
              subject: notification.subject,
              outcome: notification.outcome,
              severity: notification.severity,
              correlationId: notification.correlationId,
              createdAt: notification.at,
            },
          },
          { upsert: true, returnDocument: 'after' },
        );
      }
    },

    async watermarkFor(accountId) {
      const found = await watermarks().findOne({ _id: accountId });
      return found === null ? undefined : (found['watermark'] as string);
    },

    async setWatermark(accountId, watermark) {
      await watermarks().findOneAndUpdate(
        { _id: accountId },
        { $set: { _id: accountId, watermark } },
        { upsert: true, returnDocument: 'after' },
      );
    },
  };
  return Object.freeze(store);
}

/** The Mongo driver adapter, retaining string identifiers at the store boundary. */
export function notificationDb(db: Db): NotificationDb {
  return { collection: (name) => db.collection(name) as unknown as NotificationCollection };
}
