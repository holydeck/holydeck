// Shows who else has this content open right now. Presence is a lease this component renews by polling
// and gives up explicitly on unmount; see `presence-routes.ts`'s own header for why nothing here waits
// for the lease to expire on its own instead.

import { useEffect, useState } from 'preact/hooks';

import { parsePresenceEntry, type PresenceEntry } from '@holydeck/contracts/presence';

import { csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

const POLL_MS = 5000;

const entriesFrom = (value: unknown): readonly PresenceEntry[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const parsed = parsePresenceEntry(row, 'presence');
    return parsed.ok ? [parsed.value] : [];
  });
};

/** Who else is editing this content, as one chip per active editor. */
export function PresenceIndicator({ contentId }: { readonly contentId: string }): JSX.Element | null {
  const [entries, setEntries] = useState<readonly PresenceEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const path = `/api/v1/presence/${encodeURIComponent(contentId)}`;

    const tick = async (): Promise<void> => {
      await request(path, { method: 'POST', csrf: csrf() ?? '' });
      const result = await request(path);
      if (!cancelled && result.ok) setEntries(entriesFrom(result.data));
    };

    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      void request(path, { method: 'DELETE', csrf: csrf() ?? '' });
    };
  }, [contentId]);

  if (entries.length === 0) return null;

  return (
    <ul class="presence-indicator" aria-label={t('presence.activeEditors')}>
      {entries.map((entry) => (
        <li key={entry.actor}>
          <span role="img" aria-label={t('presence.editingLabel', { actor: entry.actor })}>
            {entry.actor.slice(0, 2).toUpperCase()}
          </span>
        </li>
      ))}
    </ul>
  );
}
