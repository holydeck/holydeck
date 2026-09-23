// Shows who else has this content open right now (COLAB-05). Presence is a lease this component renews by
// polling and gives up explicitly — on unmount, and on `pagehide`, which is the last thing a closing or
// navigating tab reliably runs; see `presence-routes.ts`'s own header for why nothing here waits for the
// lease to expire on its own instead.
//
// The session's own entry is left out: "also editing" means someone other than you, and a chip naming the
// reader would only teach them to ignore the row. Five chips at most, then a count: a sixth face tells an
// editor nothing a number does not, and the row must never push the editor itself down the page.

import { useEffect, useState } from 'preact/hooks';

import { parsePresenceEntry, type PresenceEntry } from '@holydeck/contracts/presence';

import { csrf, session } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

/** How often the lease is renewed and the others re-read: well inside the server's lease, never chatty. */
export const POLL_MS = 15_000;

/** The most editors shown by name; any more are counted. */
export const MAX_CHIPS = 5;

const entriesFrom = (value: unknown): readonly PresenceEntry[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const parsed = parsePresenceEntry(row, 'presence');
    return parsed.ok ? [parsed.value] : [];
  });
};

/** What a chip calls an editor: their account's name, or the actor when no account answered. */
const nameOf = (entry: PresenceEntry): string => entry.displayName ?? entry.actor;

/** Up to two initials from a name, so "Chioma Obi" reads "CO" and a bare actor still reads something. */
const initialsOf = (name: string): string => {
  const words = name.split(/[\s:._-]+/u).filter((word) => word.length > 0);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
};

/** Who else is editing this content, as one chip per editor after an "Also editing" label. */
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

    const leave = (): void => {
      void request(path, { method: 'DELETE', csrf: csrf() ?? '' });
    };

    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    window.addEventListener('pagehide', leave);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [contentId]);

  const self = session.value?.actor;
  const others = entries.filter((entry) => entry.actor !== self);
  if (others.length === 0) return null;

  const shown = others.slice(0, MAX_CHIPS);
  const overflow = others.length - shown.length;

  return (
    <div class="presence-indicator">
      <span id={`presence-${contentId}`}>{t('presence.alsoEditing')}</span>
      <ul aria-labelledby={`presence-${contentId}`}>
        {shown.map((entry) => (
          <li key={entry.actor}>
            <span role="img" aria-label={t('presence.editingLabel', { actor: nameOf(entry) })} title={nameOf(entry)}>
              {initialsOf(nameOf(entry))}
            </span>
          </li>
        ))}
        {overflow > 0 ? <li>{t('presence.overflow', { count: overflow })}</li> : null}
      </ul>
    </div>
  );
}
