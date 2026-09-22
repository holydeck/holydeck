import { describe, expect, it } from 'vitest';

import { parseNotificationPreferences } from './notifications.js';

const channel = { channel: 'inApp', categories: ['content', 'backup'], minimumSeverity: 'notice' };
const preference = { muted: false, ownActions: true, channels: [channel] };

describe('notification preferences', () => {
  it('accepts the complete wire shape', () => {
    expect(parseNotificationPreferences(preference)).toEqual({ ok: true, value: preference });
  });

  it.each([
    [{ ...channel, channel: 'sms' }, 'channel'],
    [{ ...channel, categories: ['unknown'] }, 'categories.0'],
    [{ ...channel, minimumSeverity: 'urgent' }, 'minimumSeverity'],
    [{ ...channel, categories: ['content', 'content'] }, 'categories.1'],
  ])('rejects an invalid channel preference at its field path', (invalid, path) => {
    const parsed = parseNotificationPreferences({ ...preference, channels: [invalid] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path))
      .toContain(`notification-preferences.channels.0.${path}`);
  });

  it('accepts no channels or no categories on a channel', () => {
    expect(parseNotificationPreferences({ muted: true, channels: [] }).ok).toBe(true);
    expect(parseNotificationPreferences({ muted: false, channels: [{ ...channel, categories: [] }] }).ok).toBe(true);
  });

  it('requires muted and validates both boolean fields', () => {
    for (const input of [{ channels: [] }, { muted: 'false', channels: [] }, { ...preference, ownActions: 'yes' }]) {
      expect(parseNotificationPreferences(input).ok).toBe(false);
    }
  });
});
