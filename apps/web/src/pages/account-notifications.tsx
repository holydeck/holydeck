// What one account hears about, and how (spec v1c-14, OUI-04). A settings-style page, not an
// administration one: every session that holds an account carries `notifications.use`
// (`roles.ts:162-167`), so this route is gated on session presence alone, the same way
// `account-security.tsx` gates its own screen. Only the preferences form ships here — the notification
// bell and its panel are OUI-04's other half (T7), out of scope for this page.

import { useEffect, useState } from 'preact/hooks';

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
  type ChannelPreferenceInput,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferenceInput,
  type NotificationSeverity,
} from '@holydeck/contracts/notifications';

import { csrf, session } from '../app-state.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

export const NOTIFICATION_PREFERENCES_PATH = '/api/v1/notifications/preferences';

const CHANNEL_LABEL: Readonly<Record<NotificationChannel, MessageKey>> = {
  inApp: 'account.notifications.channel.inApp',
  email: 'account.notifications.channel.email',
  webhook: 'account.notifications.channel.webhook',
};

interface ChannelState {
  readonly enabled: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
  readonly minimumSeverity: NotificationSeverity;
}

type ChannelsState = Readonly<Record<NotificationChannel, ChannelState>>;

const EMPTY_CHANNEL: ChannelState = { enabled: false, categories: new Set(), minimumSeverity: 'notice' };

const initialChannels = (): ChannelsState => ({ inApp: EMPTY_CHANNEL, email: EMPTY_CHANNEL, webhook: EMPTY_CHANNEL });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isChannel = (value: unknown): value is NotificationChannel =>
  typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);

const isCategory = (value: unknown): value is NotificationCategory =>
  typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);

const isSeverity = (value: unknown): value is NotificationSeverity =>
  typeof value === 'string' && (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);

const parsedChannelsState = (value: unknown): ChannelsState | undefined => {
  if (!Array.isArray(value)) return undefined;
  const next: Record<NotificationChannel, ChannelState> = { ...initialChannels() };
  for (const row of value) {
    if (!isRecord(row) || !isChannel(row['channel']) || !isSeverity(row['minimumSeverity']) || !Array.isArray(row['categories'])) {
      return undefined;
    }
    const categories = new Set<NotificationCategory>();
    for (const category of row['categories']) {
      if (!isCategory(category)) return undefined;
      categories.add(category);
    }
    next[row['channel']] = { enabled: true, categories, minimumSeverity: row['minimumSeverity'] };
  }
  return next;
};

interface PreferenceView {
  readonly muted: boolean;
  readonly ownActions: boolean;
  readonly channels: ChannelsState;
}

const parsedPreference = (value: unknown): PreferenceView | undefined => {
  if (!isRecord(value) || !isRecord(value['preferences'])) return undefined;
  const preferences = value['preferences'];
  if (typeof preferences['muted'] !== 'boolean') return undefined;
  const channels = parsedChannelsState(preferences['channels']);
  if (channels === undefined) return undefined;
  return { muted: preferences['muted'], ownActions: preferences['ownActions'] === true, channels };
};

/** One account's own notification preferences: whether it hears anything at all, and on which channels. */
export function AccountNotificationsPage(): JSX.Element {
  const currentSession = session.value;
  const permitted = currentSession != null;

  const [muted, setMuted] = useState(false);
  const [ownActions, setOwnActions] = useState(false);
  const [channels, setChannels] = useState<ChannelsState>(initialChannels);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState<string>();
  // Keyed by channel rather than by the server's numeric `channels.<index>` path: `fieldErrors()` matches
  // a validation path's final segment against a known field name, which works for `channel` or
  // `minimumSeverity` but not for a rejected list entry such as `channels.0.categories.1`, whose final
  // segment is an index, not a field. `save` below recovers the channel each such problem belongs to from
  // the index itself, using the same order it just sent the channels in.
  const [channelErrors, setChannelErrors] = useState<Partial<Record<NotificationChannel, string>>>({});

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(NOTIFICATION_PREFERENCES_PATH);
    const parsed = result.ok ? parsedPreference(result.data) : undefined;
    if (parsed !== undefined) {
      setMuted(parsed.muted);
      setOwnActions(parsed.ownActions);
      setChannels(parsed.channels);
    }
    setLoadFailed(parsed === undefined);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const toggleChannel = (channel: NotificationChannel, enabled: boolean): void => {
    setChannels((current) => ({ ...current, [channel]: { ...current[channel], enabled } }));
  };

  const toggleCategory = (channel: NotificationChannel, category: NotificationCategory, checked: boolean): void => {
    setChannels((current) => {
      const categories = new Set(current[channel].categories);
      if (checked) categories.add(category);
      else categories.delete(category);
      return { ...current, [channel]: { ...current[channel], categories } };
    });
  };

  const setSeverity = (channel: NotificationChannel, minimumSeverity: NotificationSeverity): void => {
    setChannels((current) => ({ ...current, [channel]: { ...current[channel], minimumSeverity } }));
  };

  const save = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setOther(undefined);
    setChannelErrors({});
    const channelsToSend: readonly ChannelPreferenceInput[] = NOTIFICATION_CHANNELS
      .filter((channel) => channels[channel].enabled)
      .map((channel) => ({
        channel,
        categories: [...channels[channel].categories],
        minimumSeverity: channels[channel].minimumSeverity,
      }));
    const body: NotificationPreferenceInput = { muted, ownActions, channels: channelsToSend };
    try {
      const result = await request(NOTIFICATION_PREFERENCES_PATH, { method: 'PUT', csrf: csrf() ?? '', body });
      if (!result.ok) {
        const nextChannelErrors: Partial<Record<NotificationChannel, string>> = {};
        let generalMessage: string | undefined;
        for (const problem of result.fields) {
          const match = /channels\.(\d+)/.exec(problem.path);
          const channel = match === null ? undefined : channelsToSend[Number(match[1])]?.channel;
          if (channel !== undefined) {
            if (nextChannelErrors[channel] === undefined) nextChannelErrors[channel] = problem.message;
          } else if (generalMessage === undefined) {
            generalMessage = problem.message;
          }
        }
        setChannelErrors(nextChannelErrors);
        const message = generalMessage ?? fieldErrors(result, []).other ?? result.message;
        const text = t('account.notifications.refused', { message });
        setOther(text);
        say('assertive', text);
        return;
      }
      say('polite', t('account.notifications.announce.saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1>{t('account.notifications.title')}</h1>
      {loadFailed ? <p role="alert">{t('account.notifications.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <form noValidate onSubmit={(event) => void save(event)}>
          <label>
            <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.currentTarget.checked)} />
            {t('account.notifications.muted')}
          </label>
          <label>
            <input type="checkbox" checked={ownActions} onChange={(event) => setOwnActions(event.currentTarget.checked)} />
            {t('account.notifications.ownActions')}
          </label>
          <h2>{t('account.notifications.channelsHeading')}</h2>
          {NOTIFICATION_CHANNELS.map((channel) => {
            const state = channels[channel];
            const channelLabel = t(CHANNEL_LABEL[channel]);
            const error = channelErrors[channel];
            return (
              <fieldset key={channel}>
                <legend>{channelLabel}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={state.enabled}
                    onChange={(event) => toggleChannel(channel, event.currentTarget.checked)}
                  />
                  {t('account.notifications.channel.enable', { channel: channelLabel })}
                </label>
                {error === undefined ? null : (
                  <p role="alert">{t('account.notifications.channel.fieldError', { channel: channelLabel, message: error })}</p>
                )}
                {state.enabled ? (
                  <>
                    <fieldset>
                      <legend>{t('account.notifications.categoriesHeading')}</legend>
                      {NOTIFICATION_CATEGORIES.map((category) => (
                        <label key={category}>
                          <input
                            type="checkbox"
                            checked={state.categories.has(category)}
                            onChange={(event) => toggleCategory(channel, category, event.currentTarget.checked)}
                          />
                          {t(`audit.category.${category}` as MessageKey)}
                        </label>
                      ))}
                    </fieldset>
                    <label>
                      {t('account.notifications.severityLabel')}
                      <select
                        value={state.minimumSeverity}
                        onChange={(event) => setSeverity(channel, event.currentTarget.value as NotificationSeverity)}
                      >
                        {NOTIFICATION_SEVERITIES.map((severity) => (
                          <option key={severity} value={severity}>{t(`account.notifications.severity.${severity}`)}</option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
              </fieldset>
            );
          })}
          <button type="submit" disabled={saving}>{t('account.notifications.save')}</button>
        </form>
      )}
    </>
  );
}
