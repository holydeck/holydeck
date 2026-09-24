// The bell every signed-in account carries (OUI-04): its unread count, and the panel behind it — mark
// one read, mark all read, dismiss, and a deep link to what each notification is about. Polls its own
// unread feed every POLL_MS while the tab is visible, and says a new arrival through the shell's shared
// polite live region when the panel is closed, so a screen reader hears about it without opening the panel.
//
// `?unread=true` doubles as the panel's own content: the server has no separate count endpoint, so one
// feed answers both the badge and the list. The server already excludes a dismissed row from that feed
// (`notification-store.ts`'s `listFor`), so a dismiss click only needs to update local state for the
// instant before the next poll confirms it.

import { useEffect, useRef, useState } from 'preact/hooks';

import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@holydeck/contracts/notifications';

import { csrf } from '../app-state.js';
import { t, tn } from '../i18n.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

export const NOTIFICATIONS_PATH = '/api/v1/notifications';

/** How often the unread feed is re-read while the tab is visible; paused entirely while it is hidden. */
export const POLL_MS = 30_000;

interface NotificationRow {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly subject: string;
  readonly outcome: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parsedRow = (value: unknown): NotificationRow | undefined => {
  if (!isRecord(value)) return undefined;
  const { _id, category, action, subject, outcome } = value;
  if (
    typeof _id !== 'string' ||
    typeof category !== 'string' ||
    typeof action !== 'string' ||
    typeof subject !== 'string' ||
    typeof outcome !== 'string'
  ) {
    return undefined;
  }
  return { id: _id, category, action, subject, outcome };
};

const parsedRows = (value: unknown): readonly NotificationRow[] => {
  if (!isRecord(value) || !Array.isArray(value['notifications'])) return [];
  return value['notifications'].flatMap((row) => {
    const parsed = parsedRow(row);
    return parsed === undefined ? [] : [parsed];
  });
};

const isKnownCategory = (category: string): category is NotificationCategory =>
  (NOTIFICATION_CATEGORIES as readonly string[]).includes(category);

/** Where a category's items lead when there is no page of their own to show one run or one entry. */
const CATEGORY_PATH: Readonly<Partial<Record<NotificationCategory, string>>> = {
  settings: '/admin/settings',
  backup: '/admin/backups',
  restore: '/admin/backups',
  integration: '/admin/integrations',
  authentication: '/admin/audit',
  authorization: '/admin/audit',
};

/** What a notification is about, as close as the client can get to "show me this". Unknown categories,
 * and categories with no page of their own yet, fall back to the audit log. */
const linkFor = (row: NotificationRow): string => {
  if (!isKnownCategory(row.category)) return '/admin/audit';
  if (row.category === 'content') return `/content/${encodeURIComponent(row.subject)}/history`;
  if (row.category === 'presentation') return '/services';
  return CATEGORY_PATH[row.category] ?? '/admin/audit';
};

const categoryLabel = (category: string): string =>
  isKnownCategory(category) ? t(`audit.category.${category}` as MessageKey) : category;

const outcomeLabel = (outcome: string): string =>
  outcome === 'allowed' || outcome === 'denied' || outcome === 'error'
    ? t(`audit.outcome.${outcome}` as MessageKey)
    : outcome;

/** The bell: its own unread count, and the panel of what is behind it. */
export function NotificationBell(): JSX.Element {
  const [rows, setRows] = useState<readonly NotificationRow[]>([]);
  const knownIds = useRef(new Set<string>());
  const firstLoadRef = useRef(true);
  const openRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const load = async (): Promise<void> => {
      const result = await request(`${NOTIFICATIONS_PATH}?unread=true`);
      if (cancelled || !result.ok) return;
      const next = parsedRows(result.data);
      const arrived = firstLoadRef.current ? 0 : next.filter((row) => !knownIds.current.has(row.id)).length;
      knownIds.current = new Set(next.map((row) => row.id));
      firstLoadRef.current = false;
      setRows(next);
      if (arrived > 0 && !openRef.current) {
        say('polite', tn('notifications.arrived', arrived));
      }
    };

    const start = (): void => {
      void load();
      interval = setInterval(() => void load(), POLL_MS);
    };
    const stop = (): void => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const markRead = async (id: string): Promise<void> => {
    const result = await request(`${NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/read`, { method: 'POST', csrf: csrf() ?? '' });
    if (!result.ok) return;
    knownIds.current.delete(id);
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const markAllRead = async (): Promise<void> => {
    const result = await request(`${NOTIFICATIONS_PATH}/read-all`, { method: 'POST', csrf: csrf() ?? '' });
    if (!result.ok) return;
    knownIds.current = new Set();
    setRows([]);
  };

  const dismiss = async (id: string): Promise<void> => {
    const result = await request(`${NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/dismiss`, { method: 'POST', csrf: csrf() ?? '' });
    if (!result.ok) return;
    knownIds.current.delete(id);
    setRows((current) => current.filter((row) => row.id !== id));
  };

  return (
    <details
      class="notification-bell"
      onToggle={(event) => {
        openRef.current = (event.currentTarget as HTMLDetailsElement).open;
      }}
    >
      <summary>
        {t('notifications.bell.label')}
        {rows.length > 0 ? <span class="notification-bell-badge">{rows.length}</span> : null}
      </summary>
      <div class="notification-bell-panel">
        <button type="button" onClick={() => void markAllRead()} disabled={rows.length === 0}>
          {t('notifications.markAllRead')}
        </button>
        {rows.length === 0 ? (
          <p>{t('notifications.panel.empty')}</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <a href={linkFor(row)}>{categoryLabel(row.category)}</a>
                <span>{row.action}</span>
                <span>{row.subject}</span>
                <span>{outcomeLabel(row.outcome)}</span>
                <button type="button" onClick={() => void markRead(row.id)}>{t('notifications.markRead')}</button>
                <button type="button" onClick={() => void dismiss(row.id)}>{t('notifications.dismiss')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
