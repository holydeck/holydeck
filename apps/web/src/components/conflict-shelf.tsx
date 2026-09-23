// The shelf an editor clears by hand: every losing save left for this content, settled with one of the
// two choices that need no merge. `combine` is not offered here — it carries a body only a merge UI can
// produce, and this component has none.

import { useEffect, useState } from 'preact/hooks';

import { isShelved, parseShelfEntry, shelfKey, type ShelvedConflict } from '@holydeck/contracts/collaboration';

import { csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

const outstandingFrom = (value: unknown): readonly ShelvedConflict[] => {
  const raw = (value as { outstanding?: unknown } | null)?.outstanding;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const parsed = parseShelfEntry(row, 'shelfEntry');
    return parsed.ok && isShelved(parsed.value) ? [parsed.value] : [];
  });
};

interface ConflictShelfProps {
  readonly contentId: string;
  readonly onResolved: () => void;
}

/** Everything still shelved for one piece of content, with a one-click settlement for each. */
export function ConflictShelf({ contentId, onResolved }: ConflictShelfProps): JSX.Element | null {
  const [outstanding, setOutstanding] = useState<readonly ShelvedConflict[]>([]);

  const load = async (): Promise<void> => {
    const result = await request(`/api/v1/content/${encodeURIComponent(contentId)}/conflicts`);
    if (result.ok) setOutstanding(outstandingFrom(result.data));
  };

  useEffect(() => {
    void load();
  }, [contentId]);

  const resolve = async (entry: ShelvedConflict, strategy: 'keep-mine' | 'keep-theirs'): Promise<void> => {
    const shelfEntryId = shelfKey(entry.contentId, entry.sequence);
    const result = await request(
      `/api/v1/content/${encodeURIComponent(contentId)}/conflicts/${encodeURIComponent(shelfEntryId)}/resolve`,
      { method: 'POST', csrf: csrf() ?? '', body: { strategy } },
    );
    if (result.ok) {
      onResolved();
      await load();
    }
  };

  if (outstanding.length === 0) return null;

  return (
    <section aria-label={t('conflicts.shelfLabel')}>
      <p>{t('conflicts.shelfHeading')}</p>
      <ul>
        {outstanding.map((entry) => (
          <li key={shelfKey(entry.contentId, entry.sequence)}>
            <button type="button" onClick={() => void resolve(entry, 'keep-mine')}>
              {t('conflicts.keepMine')}
            </button>
            <button type="button" onClick={() => void resolve(entry, 'keep-theirs')}>
              {t('conflicts.keepTheirs')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
